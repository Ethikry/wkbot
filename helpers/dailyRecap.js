const db = require('../db');
const { addDaysToDateKey, startOfBotDayUtcIso } = require('./botTime');

const STREAK_MILESTONES = [7, 30, 100, 365];
const MAX_HIGHLIGHT_LINES = 12;
const MAX_BURN_CHARACTERS = 8;
// Personal-best callouts need enough history to be meaningful (mirrors the
// guard in weeklyExtras.buildWeeklyExtras).
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
             COALESCE(rs.cleared_enabled, 1) AS cleared_enabled,
             COALESCE(rs.burn_announcement_enabled, 1) AS burn_enabled
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

    const snapRows = await db.all(
        `SELECT discord_user_id, reviews_completed, lessons_completed, goal_met, burned_count
         FROM daily_snapshots
         WHERE guild_id = ? AND snapshot_date = ?`,
        [guildId, recapDateKey]
    );
    const snaps = new Map(snapRows.map(r => [r.discord_user_id, r]));

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
                ? `**${name}** 💤 no activity — **${due}** review${due === 1 ? '' : 's'} waiting`
                : `**${name}** 💤 no activity`);
            continue;
        }

        const bits = [`**${reviews}** review${reviews === 1 ? '' : 's'}`, `**${lessons}** lesson${lessons === 1 ? '' : 's'}`];
        if (goalMet === 1) bits.push('🎯 goal met');
        else if (goalMet === 0) bits.push('▫️ goal missed');
        const streak = streaks.get(m.discord_user_id);
        if (streak && streak.current_streak > 0 && streak.last_review_date >= recapDateKey) {
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

    // Burns — exact items from wk_assignments.burned_at (synced hourly).
    if (settings?.burn_celebrations_enabled) {
        const burnMembers = members.filter(m => m.burn_enabled !== 0);
        if (burnMembers.length) {
            const burnRows = await db.all(
                `SELECT a.wanikani_user_id, s.characters
                 FROM wk_assignments a
                 JOIN wk_subjects s ON s.subject_id = a.subject_id
                 WHERE a.hidden = 0
                   AND a.burned_at >= ? AND a.burned_at < ?
                   AND a.wanikani_user_id IN (${burnMembers.map(() => '?').join(',')})`,
                [startIso, endIso, ...burnMembers.map(m => m.wanikani_user_id)]
            );
            const burnsByWk = new Map();
            for (const r of burnRows) {
                if (!burnsByWk.has(r.wanikani_user_id)) burnsByWk.set(r.wanikani_user_id, []);
                burnsByWk.get(r.wanikani_user_id).push(r.characters);
            }
            for (const m of burnMembers) {
                const burned = burnsByWk.get(m.wanikani_user_id);
                if (!burned?.length) continue;
                const chars = burned.filter(Boolean).slice(0, MAX_BURN_CHARACTERS);
                const extra = burned.length - chars.length;
                const charStr = chars.length
                    ? ` (${chars.join(' ')}${extra > 0 ? ` +${extra} more` : ''})`
                    : '';
                const total = snaps.get(m.discord_user_id)?.burned_count;
                const totalStr = total ? ` — ${total} total` : '';
                highlights.push(`🔥 **${nameOf(m.discord_user_id)}** burned **${burned.length}** item${burned.length === 1 ? '' : 's'}${charStr}${totalStr}`);
            }
        }
    }

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

    // Personal daily records.
    const priorRows = await db.all(
        `SELECT discord_user_id, MAX(reviews_completed) AS prev_max, COUNT(*) AS days
         FROM daily_snapshots
         WHERE guild_id = ? AND snapshot_date < ?
         GROUP BY discord_user_id`,
        [guildId, recapDateKey]
    );
    const priors = new Map(priorRows.map(r => [r.discord_user_id, r]));
    for (const m of members) {
        const snap = snaps.get(m.discord_user_id);
        const prior = priors.get(m.discord_user_id);
        if (!snap || !prior) continue;
        if (prior.days < PERSONAL_BEST_MIN_DAYS || !prior.prev_max) continue;
        if ((snap.reviews_completed ?? 0) > prior.prev_max) {
            highlights.push(`🏅 New personal best: **${nameOf(m.discord_user_id)}** — ${snap.reviews_completed} reviews in a day (prev ${prior.prev_max})`);
        }
    }

    // Streak milestones crossed on the recap day.
    for (const m of members) {
        const streak = streaks.get(m.discord_user_id);
        if (!streak || streak.last_review_date !== recapDateKey) continue;
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
        todayBits.push(due > 0 && next24 > 0
            ? `**${nameOf(m.discord_user_id)}** ${due} due (+${next24} in 24h)`
            : `**${nameOf(m.discord_user_id)}** ${due > 0 ? `${due} due` : next24 > 0 ? `+${next24} in 24h` : '0 due'}`);
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
            name: '📥 Today',
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
