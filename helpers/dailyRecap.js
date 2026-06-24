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

// Evaluates and persists daily_snapshots.goal_met for the day being closed,
// then recomputes per-user goal streaks the same self-healing way the review
// streak is computed (walk back from the recap day while goal_met = 1).
// Call after updateSnapshotsAndStreaks so the recap day's row is final.
async function finalizeGoalDay(guildId, recapDateKey, timeZone) {
    const startIso = startOfBotDayUtcIso(recapDateKey, timeZone);
    const endIso = startOfBotDayUtcIso(addDaysToDateKey(recapDateKey, 1), timeZone);

    const goals = await db.all(
        `SELECT ug.discord_user_id, ug.daily_lessons, ug.clear_queue
         FROM user_goals ug
         JOIN guild_members gm ON gm.discord_user_id = ug.discord_user_id
         WHERE gm.guild_id = ?
           AND (ug.daily_lessons IS NOT NULL OR ug.clear_queue = 1)`,
        [guildId]
    );
    if (goals.length === 0) return;

    const clears = await countQueueClears(guildId, startIso, endIso);

    for (const goal of goals) {
        try {
            const snap = await db.get(
                `SELECT reviews_completed, lessons_completed, reviews_available
                 FROM daily_snapshots
                 WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date = ?`,
                [guildId, goal.discord_user_id, recapDateKey]
            );
            if (!snap) continue;

            const lessonsOk = goal.daily_lessons === null
                || (snap.lessons_completed ?? 0) >= goal.daily_lessons;

            // "Clear my queue" counts when the user did reviews and either
            // ended the day at zero or hit zero at some point during it
            // (revived evaluateAllGoal semantics from helpers/zerostate.js).
            let clearOk = true;
            if (goal.clear_queue === 1) {
                const didReviews = (snap.reviews_completed ?? 0) > 0;
                const endedAtZero = (snap.reviews_available ?? 0) === 0;
                const clearedDuringDay = (clears.get(goal.discord_user_id) ?? 0) > 0;
                clearOk = didReviews && (endedAtZero || clearedDuringDay);
            }

            const met = lessonsOk && clearOk ? 1 : 0;
            await db.run(
                `UPDATE daily_snapshots SET goal_met = ?
                 WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date = ?`,
                [met, guildId, goal.discord_user_id, recapDateKey]
            );

            const history = await db.all(
                `SELECT snapshot_date, goal_met FROM daily_snapshots
                 WHERE guild_id = ? AND discord_user_id = ?
                 ORDER BY snapshot_date DESC
                 LIMIT 365`,
                [guildId, goal.discord_user_id]
            );
            const histMap = new Map(history.map(h => [h.snapshot_date, h.goal_met]));
            let goalStreak = 0;
            let cursor = recapDateKey;
            while (histMap.get(cursor) === 1) {
                goalStreak++;
                cursor = addDaysToDateKey(cursor, -1);
            }

            await db.run(
                `INSERT INTO streaks (guild_id, discord_user_id, goal_current_streak, goal_longest_streak)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
                    goal_current_streak = excluded.goal_current_streak,
                    goal_longest_streak = max(streaks.goal_longest_streak, excluded.goal_longest_streak),
                    updated_at = CURRENT_TIMESTAMP`,
                [guildId, goal.discord_user_id, goalStreak, goalStreak]
            );
        } catch (err) {
            console.error(`[finalizeGoalDay] ${goal.discord_user_id}@${guildId}:`, err);
        }
    }
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
            `SELECT reviews_completed, lessons_completed, goal_met
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
        `SELECT wanikani_user_id, review_count_now, review_count_24h FROM wk_summary_cache
         WHERE wanikani_user_id IN (${members.map(() => '?').join(',')})`,
        members.map(m => m.wanikani_user_id)
    );
    const caches = new Map(cacheRows.map(r => [r.wanikani_user_id, r]));

    // ── per-user lines + server totals ──────────────────────────────────
    let totalReviews = 0;
    let totalLessons = 0;
    let goalsTotal = 0;
    let goalsMet = 0;
    const userLines = [];
    for (const m of members) {
        const name = nameOf(m.discord_user_id);
        const snap = snaps.get(m.discord_user_id);
        const goalMet = snap?.goal_met ?? null;
        if (goalMet !== null) {
            goalsTotal++;
            if (goalMet === 1) goalsMet++;
        }
        if (m.current_vacation_started_at) {
            userLines.push(`**${name}** 🏖️ Vacation mode`);
            continue;
        }
        const reviews = snap?.reviews_completed ?? 0;
        const lessons = snap?.lessons_completed ?? 0;
        totalReviews += reviews;
        totalLessons += lessons;

        const cache = caches.get(m.wanikani_user_id);
        if (reviews === 0 && lessons === 0) {
            const due = cache?.review_count_now ?? 0;
            userLines.push(due > 0
                ? `**${name}** 💤 no activity · ${due} due`
                : `**${name}** 💤 no activity`);
            continue;
        }

        const bits = [`**${reviews}** review${reviews === 1 ? '' : 's'}`];
        if (lessons > 0) bits.push(`**${lessons}** lesson${lessons === 1 ? '' : 's'}`);
        if (goalMet === 1) bits.push('🎯');
        else if (goalMet === 0) bits.push('▫️');
        const streak = streaks.get(m.discord_user_id);
        if (streak && streak.current_streak > 0 && streak.last_review_date >= userYesterdays.get(m.discord_user_id)) {
            bits.push(`🔥 ${streak.current_streak}`);
        }
        userLines.push(`**${name}** ✅ ${bits.join(' · ')}`);
    }

    const serverBits = [
        `**${totalReviews}** reviews`,
        `**${totalLessons}** lessons`,
    ];
    if (goalsTotal > 0) serverBits.push(`**${goalsMet}/${goalsTotal}** goals met`);
    const description = clipDescription([serverBits.join(' · '), '', ...userLines].join('\n'));

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

    // ── today line (current queues from the 5-minute summary cache) ─────
    const todayBits = [];
    for (const m of members) {
        if (m.current_vacation_started_at) continue;
        const cache = caches.get(m.wanikani_user_id);
        const due = cache?.review_count_now ?? 0;
        const next24 = Math.max(0, (cache?.review_count_24h ?? 0) - due);
        if (due === 0 && next24 === 0) continue;
        todayBits.push(due > 0 && next24 > 0
            ? `**${nameOf(m.discord_user_id)}** ${due} due (+${next24})`
            : `**${nameOf(m.discord_user_id)}** ${due > 0 ? `${due} due` : `+${next24} coming`}`);
    }

    const fields = [];
    if (highlights.length) {
        fields.push({
            name: '🌟 Highlights',
            value: clipFieldValue(highlights.slice(0, MAX_HIGHLIGHT_LINES).join('\n')),
            inline: false,
        });
    }
    if (todayBits.length) {
        fields.push({
            name: '📥 Up next',
            value: clipFieldValue(todayBits.join(' · ')),
            inline: false,
        });
    }

    return {
        title: `📅 Daily Recap — ${formatRecapDate(recapDateKey)}`,
        description,
        fields,
    };
}

module.exports = { buildDailyRecap, finalizeGoalDay, countQueueClears };
