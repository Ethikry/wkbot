const db = require('../db');
const { addDaysToDateKey, botDateKey, startOfBotDayUtcIso } = require('./botTime');
const { getEffectiveUserTimeZone } = require('./tzInfer');

const STREAK_MILESTONES = [7, 30, 100, 365];
const MAX_HIGHLIGHT_LINES = 12;
const PERSONAL_BEST_MIN_DAYS = 14;

const DAY_FULL_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

function formatRecapDate(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d, 12));
    return `${DAY_FULL_NAMES[day.getUTCDay()]}, ${MONTH_NAMES[m - 1]} ${d}`;
}

async function fetchDisplayName(guild, userId) {
    const m = await guild.members.fetch(userId).catch(() => null);
    return m?.displayName ?? 'Unknown';
}

function clipFieldValue(s) {
    const MAX = 1024;
    if (s.length <= MAX) return s;
    return s.slice(0, MAX - 12) + '\n*…and more*';
}

function clipDescription(s) {
    const MAX = 4000;
    if (s.length <= MAX) return s;
    return s.slice(0, MAX - 20) + '\n*…and more*';
}

// Members of the guild with a linked WK account, with the per-guild recap
// opt-ins folded in (defaults match reminder_settings defaults).
async function getRecapMembers(guildId) {
    return db.all(
        `SELECT
             gm.discord_user_id,
             wa.wanikani_user_id,
             wa.level,
             wa.current_vacation_started_at,
             COALESCE(rs.cleared_enabled, 1) AS cleared_enabled
         FROM guild_members gm
         JOIN wanikani_accounts wa ON wa.discord_user_id = gm.discord_user_id
         LEFT JOIN reminder_settings rs
             ON rs.guild_id = gm.guild_id AND rs.discord_user_id = gm.discord_user_id
         WHERE gm.guild_id = ?`,
        [guildId]
    );
}

// Counts >0 → 0 transitions per user in queue_history within the window.
// queue_history is polled every 5 minutes and pruned at 48h, so a recap of
// the day that just closed always has full coverage.
async function countQueueClears(guildId, startIso, endIso) {
    const rows = await db.all(
        `SELECT discord_user_id, recorded_at, queue_size FROM queue_history
         WHERE guild_id = ? AND recorded_at >= ? AND recorded_at < ?
         ORDER BY discord_user_id, recorded_at`,
        [guildId, startIso, endIso]
    );
    const clears = new Map();
    let prevUser = null;
    let prevSize = null;
    for (const r of rows) {
        if (r.discord_user_id !== prevUser) {
            prevUser = r.discord_user_id;
            prevSize = null;
        }
        if (prevSize !== null && prevSize > 0 && r.queue_size === 0) {
            clears.set(r.discord_user_id, (clears.get(r.discord_user_id) ?? 0) + 1);
        }
        prevSize = r.queue_size;
    }
    return clears;
}

// Builds the daily recap as plain embed data ({ title, description, fields })
// for the bot-day that just closed. Reads only the local DB (snapshots,
// streaks, queue_history, wk_assignments, wk_summary_cache) — no WK API
// calls — so it's fast at post time and previewable offline; `guild` is only
// used to resolve display names.
async function buildDailyRecap(guildId, guild, timeZone, recapDateKey) {
    const settings = await db.get(`SELECT * FROM guild_settings WHERE guild_id = ?`, [guildId]);
    const startIso = startOfBotDayUtcIso(recapDateKey, timeZone);
    const endIso = startOfBotDayUtcIso(addDaysToDateKey(recapDateKey, 1), timeZone);

    const members = await getRecapMembers(guildId);
    if (members.length === 0) return null;

    const names = new Map();
    await Promise.all(members.map(async m => {
        names.set(m.discord_user_id, await fetchDisplayName(guild, m.discord_user_id));
    }));
    const nameOf = id => names.get(id) ?? 'Unknown';

    // Read each user's snapshot for their personal "yesterday" — the most
    // recently completed 24h day in their own timezone. daily_snapshots uses
    // per-user timezone date keys, so snapshot_date "Jun 22" means different
    // UTC windows for a JST user vs a PDT user. At midnight JST the recap
    // fires, a PDT user's current day is only 8 hours old; their prior day is
    // the one that's actually finished. Reading that row gives a complete
    // picture rather than a partial one.
    const now = new Date();
    const snaps = new Map();
    const userYesterdays = new Map();
    for (const m of members) {
        const { timeZone: userTz } = await getEffectiveUserTimeZone(m.discord_user_id, timeZone);
        const userYesterday = addDaysToDateKey(botDateKey(now, userTz), -1);
        userYesterdays.set(m.discord_user_id, userYesterday);
        const snap = await db.get(
            `SELECT reviews_completed, lessons_completed
             FROM daily_snapshots
             WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date = ?`,
            [guildId, m.discord_user_id, userYesterday]
        );
        if (snap) snaps.set(m.discord_user_id, snap);
    }

    const streakRows = await db.all(
        `SELECT discord_user_id, current_streak, last_review_date, goal_current_streak
         FROM streaks WHERE guild_id = ?`,
        [guildId]
    );
    const streaks = new Map(streakRows.map(r => [r.discord_user_id, r]));

    const cacheRows = await db.all(
        `SELECT wanikani_user_id, lesson_count, review_count_now, review_count_24h FROM wk_summary_cache
         WHERE wanikani_user_id IN (${members.map(() => '?').join(',')})`,
        members.map(m => m.wanikani_user_id)
    );
    const caches = new Map(cacheRows.map(r => [r.wanikani_user_id, r]));

    // ── per-user entries + server totals ────────────────────────────────
    let totalReviews = 0;
    let totalLessons = 0;
    let activeMembers = 0;
    let countedMembers = 0;
    let totalLessonsAvail = 0;
    let totalDue24 = 0;
    const userLines = [];
    for (const m of members) {
        const name = nameOf(m.discord_user_id);
        const snap = snaps.get(m.discord_user_id);
        if (m.current_vacation_started_at) {
            userLines.push(`**${name}** · Lv **${m.level}** · 🏖️ Vacation mode`);
            continue;
        }
        countedMembers++;
        const reviews = snap?.reviews_completed ?? 0;
        const lessons = snap?.lessons_completed ?? 0;
        totalReviews += reviews;
        totalLessons += lessons;
        if (reviews > 0 || lessons > 0) activeMembers++;

        const cache = caches.get(m.wanikani_user_id);
        const lessonsAvail = cache?.lesson_count ?? 0;
        const due24 = cache?.review_count_24h ?? 0;
        totalLessonsAvail += lessonsAvail;
        totalDue24 += due24;

        const head = [`**${name}**`, `Lv **${m.level}**`];
        const streak = streaks.get(m.discord_user_id);
        if (streak && streak.current_streak > 0 && streak.last_review_date >= userYesterdays.get(m.discord_user_id)) {
            head.push(`🔥 **${streak.current_streak}** day streak`);
        }

        const doneBits = [];
        if (lessons > 0) doneBits.push(`✏️ **${lessons}** lesson${lessons === 1 ? '' : 's'} completed`);
        if (reviews > 0) doneBits.push(`✅ **${reviews}** review${reviews === 1 ? '' : 's'} cleared`);
        const lines = [head.join(' · '), `> ${doneBits.length ? doneBits.join(' · ') : '💤 no activity'}`];

        const upBits = [];
        if (lessonsAvail > 0) upBits.push(`📚 **${lessonsAvail}** lesson${lessonsAvail === 1 ? '' : 's'} ready`);
        if (due24 > 0) upBits.push(`📥 **${due24}** review${due24 === 1 ? '' : 's'} due (24h)`);
        if (upBits.length) lines.push(`> ${upBits.join(' · ')}`);

        userLines.push(lines.join('\n'));
    }
    const description = clipDescription(userLines.join('\n'));

    const totalsLines = [
        `✏️ **${totalLessons}** lessons completed · ✅ **${totalReviews}** reviews cleared`,
        `🙋 **${activeMembers}/${countedMembers}** members active`,
        `📚 **${totalLessonsAvail}** lessons ready · 📥 **${totalDue24}** reviews due (24h)`,
    ];

    // ── highlights digest ────────────────────────────────────────────────
    const highlights = [];

    // Queue clears — >0 → 0 transitions observed by the 5-minute poll.
    if (settings?.reviews_cleared_announcements_enabled) {
        const clears = await countQueueClears(guildId, startIso, endIso);
        for (const m of members) {
            if (m.cleared_enabled === 0) continue;
            const n = clears.get(m.discord_user_id) ?? 0;
            if (n === 0) continue;
            highlights.push(`🧹 **${nameOf(m.discord_user_id)}** cleared their queue${n > 1 ? ` ${n}×` : ''}`);
        }
    }

    // Personal daily records — compared against each user's own history
    // up to (but not including) their personal yesterday.
    for (const m of members) {
        const snap = snaps.get(m.discord_user_id);
        if (!snap) continue;
        const userYesterday = userYesterdays.get(m.discord_user_id);
        const prior = await db.get(
            `SELECT MAX(reviews_completed) AS prev_max, COUNT(*) AS days
             FROM daily_snapshots
             WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date < ?`,
            [guildId, m.discord_user_id, userYesterday]
        );
        if (!prior || prior.days < PERSONAL_BEST_MIN_DAYS || !prior.prev_max) continue;
        if ((snap.reviews_completed ?? 0) > prior.prev_max) {
            highlights.push(`🏅 New personal best: **${nameOf(m.discord_user_id)}** — ${snap.reviews_completed} reviews in a day (prev ${prior.prev_max})`);
        }
    }

    // Streak milestones crossed on the user's personal yesterday.
    for (const m of members) {
        const streak = streaks.get(m.discord_user_id);
        if (!streak || streak.last_review_date !== userYesterdays.get(m.discord_user_id)) continue;
        if (STREAK_MILESTONES.includes(streak.current_streak)) {
            highlights.push(`✨ **${nameOf(m.discord_user_id)}** hit a ${streak.current_streak}-day streak!`);
        }
    }

    // Achievements unlocked during the day (these previously unlocked silently).
    const achRows = await db.all(
        `SELECT ua.discord_user_id, ad.name
         FROM user_achievements ua
         JOIN achievement_definitions ad ON ad.achievement_key = ua.achievement_key
         WHERE ua.unlocked_at >= ? AND ua.unlocked_at < ?
           AND ua.discord_user_id IN (${members.map(() => '?').join(',')})`,
        [startIso, endIso, ...members.map(m => m.discord_user_id)]
    );
    for (const r of achRows) {
        highlights.push(`🏆 **${nameOf(r.discord_user_id)}** unlocked “${r.name}”`);
    }

    const fields = [];
    if (highlights.length) {
        fields.push({
            name: '🌟 Highlights',
            value: clipFieldValue(highlights.slice(0, MAX_HIGHLIGHT_LINES).join('\n')),
            inline: false,
        });
    }
    fields.push({
        name: '📊 Server Totals',
        value: clipFieldValue(totalsLines.join('\n')),
        inline: false,
    });

    return {
        title: `📅 Daily Recap — ${formatRecapDate(recapDateKey)}`,
        description,
        fields,
    };
}

module.exports = { buildDailyRecap, countQueueClears };
