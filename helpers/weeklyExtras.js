const db = require('../db');
const { addDaysToDateKey, botDateKey } = require('./botTime');

const DAY_FULL_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dateKeyToDayName(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return DAY_FULL_NAMES[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
}

async function fetchDisplayName(guild, userId) {
    const m = await guild.members.fetch(userId).catch(() => null);
    return m?.displayName ?? 'Unknown';
}

// Builds the optional "extras" embed fields shown alongside the weekly
// leaderboard: server totals + best day + milestones, and a highlights block
// (most improved / personal bests / perfect-week attendance).
//
// Window matches the existing leaderboard query (snapshot_date >= today-7),
// which is 8 calendar days inclusive of today — kept consistent so users see
// matching numbers across the embed.
async function buildWeeklyExtras(guildId, guild, timeZone) {
    const today = botDateKey(new Date(), timeZone);
    const weekStart = addDaysToDateKey(today, -7);
    const prevWeekStart = addDaysToDateKey(today, -14);

    const dailyTotals = await db.all(
        `SELECT snapshot_date,
                COALESCE(SUM(reviews_completed), 0) AS reviews,
                COALESCE(SUM(lessons_completed), 0) AS lessons
         FROM daily_snapshots
         WHERE guild_id = ? AND snapshot_date >= ?
         GROUP BY snapshot_date
         ORDER BY snapshot_date`,
        [guildId, weekStart]
    );

    const totalReviews = dailyTotals.reduce((a, r) => a + r.reviews, 0);
    const totalLessons = dailyTotals.reduce((a, r) => a + r.lessons, 0);

    const activeRow = await db.get(
        `SELECT COUNT(DISTINCT discord_user_id) AS n
         FROM daily_snapshots
         WHERE guild_id = ? AND snapshot_date >= ?
           AND (reviews_completed > 0 OR lessons_completed > 0)`,
        [guildId, weekStart]
    );
    const activeMembers = activeRow?.n ?? 0;

    const bestDay = dailyTotals.reduce(
        (best, r) => (r.reviews > (best?.reviews ?? -1) ? r : best),
        null
    );

    // Pull review + level + burn snapshots for the past 14 days in one query;
    // we'll bucket per-user in JS for milestones, most-improved, and perfect-week.
    const recentRows = await db.all(
        `SELECT discord_user_id, snapshot_date, reviews_completed, level, burned_count
         FROM daily_snapshots
         WHERE guild_id = ? AND snapshot_date >= ?
         ORDER BY discord_user_id, snapshot_date`,
        [guildId, prevWeekStart]
    );

    const reviewsThisWeek = new Map();
    const reviewsPrevWeek = new Map();
    const perfectAttendance = new Map();
    const byUser = new Map();
    for (const r of recentRows) {
        if (!byUser.has(r.discord_user_id)) byUser.set(r.discord_user_id, []);
        byUser.get(r.discord_user_id).push(r);
        if (r.snapshot_date >= weekStart) {
            reviewsThisWeek.set(r.discord_user_id, (reviewsThisWeek.get(r.discord_user_id) ?? 0) + (r.reviews_completed ?? 0));
            if ((r.reviews_completed ?? 0) > 0) {
                perfectAttendance.set(r.discord_user_id, (perfectAttendance.get(r.discord_user_id) ?? 0) + 1);
            }
        } else {
            reviewsPrevWeek.set(r.discord_user_id, (reviewsPrevWeek.get(r.discord_user_id) ?? 0) + (r.reviews_completed ?? 0));
        }
    }

    let levelUps = 0;
    let burnsDelta = 0;
    for (const snaps of byUser.values()) {
        const inWeek = snaps.filter(s => s.snapshot_date >= weekStart);
        if (inWeek.length === 0) continue;
        const beforeWeek = snaps.filter(s => s.snapshot_date < weekStart);
        const baseline = beforeWeek.length > 0 ? beforeWeek[beforeWeek.length - 1] : inWeek[0];
        const latest = inWeek[inWeek.length - 1];
        levelUps += Math.max(0, latest.level - baseline.level);
        burnsDelta += Math.max(0, latest.burned_count - baseline.burned_count);
    }

    let mostImproved = null;
    for (const [userId, thisN] of reviewsThisWeek) {
        const prevN = reviewsPrevWeek.get(userId) ?? 0;
        const delta = thisN - prevN;
        if (delta > 0 && (mostImproved === null || delta > mostImproved.delta)) {
            mostImproved = { userId, delta };
        }
    }

    // Perfect week: reviewed on at least 7 distinct days within the window.
    const perfectUserIds = [...perfectAttendance.entries()]
        .filter(([, n]) => n >= 7)
        .map(([id]) => id);

    // Personal best: this-week reviews exceeds the user's highest prior 7-day
    // rolling sum. Limit history to 90 days to keep this cheap.
    const longRangeStart = addDaysToDateKey(today, -90);
    const historyRows = await db.all(
        `SELECT discord_user_id, snapshot_date, reviews_completed
         FROM daily_snapshots
         WHERE guild_id = ? AND snapshot_date >= ? AND snapshot_date < ?`,
        [guildId, longRangeStart, weekStart]
    );
    const historyByUser = new Map();
    for (const r of historyRows) {
        if (!historyByUser.has(r.discord_user_id)) historyByUser.set(r.discord_user_id, new Map());
        historyByUser.get(r.discord_user_id).set(r.snapshot_date, r.reviews_completed ?? 0);
    }
    const personalBests = [];
    for (const [userId, thisTotal] of reviewsThisWeek) {
        if (thisTotal === 0) continue;
        const dateMap = historyByUser.get(userId);
        if (!dateMap || dateMap.size < 7) continue;
        const sortedDates = [...dateMap.keys()].sort();
        let prevMax = 0;
        for (const endDate of sortedDates) {
            let sum = 0;
            for (let i = 0; i < 7; i++) {
                sum += dateMap.get(addDaysToDateKey(endDate, -i)) ?? 0;
            }
            if (sum > prevMax) prevMax = sum;
        }
        if (prevMax > 0 && thisTotal > prevMax) {
            personalBests.push({ userId, total: thisTotal, prev: prevMax });
        }
    }
    personalBests.sort((a, b) => (b.total - b.prev) - (a.total - a.prev));

    // Burn forecast: Enlightened items (srs_stage 8) whose next review lands
    // within the coming week — each one is a burn if answered correctly.
    const burnForecast = await db.all(
        `SELECT gm.discord_user_id, COUNT(*) AS n
         FROM guild_members gm
         JOIN wanikani_accounts wa ON wa.discord_user_id = gm.discord_user_id
         JOIN wk_assignments a ON a.wanikani_user_id = wa.wanikani_user_id
         WHERE gm.guild_id = ? AND a.hidden = 0 AND a.srs_stage = 8
           AND a.available_at IS NOT NULL
           AND datetime(a.available_at) < datetime('now', '+7 days')
         GROUP BY gm.discord_user_id
         ORDER BY n DESC
         LIMIT 5`,
        [guildId]
    );

    const [improvedName, perfectNames, pbResolved, forecastResolved] = await Promise.all([
        mostImproved ? fetchDisplayName(guild, mostImproved.userId) : null,
        Promise.all(perfectUserIds.slice(0, 10).map(id => fetchDisplayName(guild, id))),
        Promise.all(personalBests.slice(0, 3).map(async pb => ({
            ...pb,
            name: await fetchDisplayName(guild, pb.userId),
        }))),
        Promise.all(burnForecast.map(async f => ({
            ...f,
            name: await fetchDisplayName(guild, f.discord_user_id),
        }))),
    ]);

    const serverLines = [];
    if (totalReviews > 0 || totalLessons > 0) {
        const memberWord = activeMembers === 1 ? 'member' : 'members';
        serverLines.push(`Total: **${totalReviews}** reviews · **${totalLessons}** lessons · **${activeMembers}** active ${memberWord}`);
    }
    if (bestDay && bestDay.reviews > 0) {
        serverLines.push(`Best day: **${dateKeyToDayName(bestDay.snapshot_date)}** (${bestDay.reviews} reviews)`);
    }
    const milestoneBits = [];
    if (levelUps > 0) milestoneBits.push(`🆙 **${levelUps}** level-up${levelUps === 1 ? '' : 's'}`);
    if (burnsDelta > 0) milestoneBits.push(`🔥 **${burnsDelta}** burn${burnsDelta === 1 ? '' : 's'}`);
    if (milestoneBits.length) serverLines.push(milestoneBits.join(' · '));
    if (forecastResolved.length) {
        serverLines.push(`🔮 Up for burn this week: ${forecastResolved.map(f => `**${f.name}** ${f.n}`).join(' · ')}`);
    }

    const highlightLines = [];
    if (mostImproved && improvedName) {
        highlightLines.push(`📈 Most improved: **${improvedName}** (+${mostImproved.delta} reviews vs last week)`);
    }
    for (const pb of pbResolved) {
        highlightLines.push(`🎯 Personal best: **${pb.name}** — ${pb.total} reviews (prev: ${pb.prev})`);
    }
    if (perfectNames.length) {
        highlightLines.push(`✨ Perfect week: ${perfectNames.map(n => `**${n}**`).join(', ')}`);
    }

    const fields = [];
    if (serverLines.length) {
        fields.push({ name: '📊 Server This Week', value: serverLines.join('\n'), inline: false });
    }
    if (highlightLines.length) {
        fields.push({ name: '🌟 Highlights', value: highlightLines.join('\n'), inline: false });
    }
    return { fields };
}

module.exports = { buildWeeklyExtras };
