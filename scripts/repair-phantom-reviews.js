#!/usr/bin/env node
//
// Lowers daily_snapshots.reviews_completed on days where the count came from
// WaniKani re-stamping assignments rather than from reviews, then replays the
// streaks those days were propping up.
//
// When staff edit a subject's content, WK re-stamps every user's assignment
// and review_statistic for it with the answer counts unchanged. The snapshot
// job used to count each of those as a review, so idle days showed "1 review"
// and kept streaks alive — for an account on vacation, indefinitely. The job
// now checks answer counts (see answersRoseAround in scheduler.js), but rows it
// wrote before keep their inflated counts: backfilled days only ever move up.
//
// Past assignment timestamps are gone, so the evidence here is the review-stat
// history: a day's count is capped at the number of subjects whose answer total
// rose that day. The cap only lowers counts, never raises them. Lessons are
// left alone. For a user whose snapshots change, longest_streak is replayed
// from the corrected history too, since the inflated streak may have set it —
// but only ever lowered: history older than --since still replays differently
// from how the streak was counted at the time.
//
// Days are read in each user's current timezone, which is only how snapshots
// were keyed from 2026-06-23 on: before that the bot inferred timezones from
// activity, and some users' June days sit a day off from the history. Hence
// the --since default, which also skips the few days after, whose rows the
// snapshot job's max() kept from before. Earlier days are left as they are.
//
// Usage:
//   node scripts/repair-phantom-reviews.js                    Dry run, every user
//   node scripts/repair-phantom-reviews.js --apply            Write the new values
//   node scripts/repair-phantom-reviews.js --user <id|name>   One user (Discord id or WK username)
//   node scripts/repair-phantom-reviews.js --since 2026-07-01 First day to repair (default 2026-06-26)
//
// Dry run by default: nothing is written without --apply.

const db = require('../db');
const { computeReviewStreak } = require('../helpers/streaks');
const { addDaysToDateKey, botDateKey, resolveTimeZone, startOfBotDayUtcIso } = require('../helpers/botTime');
const { getEffectiveUserTimeZone } = require('../helpers/tzInfer');

// Same allowance as the snapshot job: a burn's stat can land minutes before
// its assignment, so a review just after midnight may have its answers
// recorded just before it.
const ANSWER_LOOKBACK_MS = 60 * 60 * 1000;

function parseArgs(argv) {
    const args = { apply: false, user: null, since: '2026-06-26' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') args.apply = true;
        else if (a === '--user') args.user = argv[++i];
        else if (a === '--since') args.since = argv[++i];
        else {
            console.error(`Unknown argument: ${a}`);
            process.exit(1);
        }
    }
    return args;
}

async function resolveUserFilter(needle) {
    if (/^\d{5,}$/.test(needle)) return [needle];
    const rows = await db.all(
        `SELECT DISTINCT discord_user_id FROM wanikani_accounts
         WHERE username LIKE ? COLLATE NOCASE`,
        [`%${needle}%`]
    );
    return rows.map(r => r.discord_user_id);
}

// Every moment a subject's answer total went up, as { subjectId, at }. A
// subject's first recorded version counts too: it is either the stat's
// creation (the first review) or a pre-tracking state we can't judge, and
// counting it can only keep a count from being lowered.
async function loadAnswerEvents(wanikaniUserId) {
    const rows = await db.all(
        `SELECT subject_id, recorded_at,
                meaning_correct + meaning_incorrect + reading_correct + reading_incorrect AS total
         FROM wk_review_stat_history
         WHERE wanikani_user_id = ?
         ORDER BY subject_id, recorded_at`,
        [wanikaniUserId]
    );
    const events = [];
    let prev = null;
    for (const r of rows) {
        if (!prev || prev.subject_id !== r.subject_id || r.total > prev.total) {
            events.push({ subjectId: r.subject_id, at: new Date(r.recorded_at).getTime() });
        }
        prev = r;
    }
    return events;
}

// The highest streak the history ever reached. Replaying with each day as
// "today" reports a frozen day only from the day after, which still lands
// every peak somewhere in the scan.
function longestStreak(history, todayKey, floorDate) {
    let day = history.reduce((min, h) => (h.snapshot_date < min ? h.snapshot_date : min), todayKey);
    let best = 0;
    while (day <= todayKey) {
        best = Math.max(best, computeReviewStreak(history, day, { floorDate }).currentStreak);
        day = addDaysToDateKey(day, 1);
    }
    return best;
}

function answeredSubjectCount(events, dateKey, timeZone) {
    const start = new Date(startOfBotDayUtcIso(dateKey, timeZone)).getTime() - ANSWER_LOOKBACK_MS;
    const end = new Date(startOfBotDayUtcIso(addDaysToDateKey(dateKey, 1), timeZone)).getTime();
    const subjects = new Set();
    for (const e of events) if (e.at >= start && e.at < end) subjects.add(e.subjectId);
    return subjects.size;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await db.init();

    let filter = null;
    if (args.user) {
        filter = await resolveUserFilter(args.user);
        if (filter.length === 0) {
            console.error(`No linked account matches "${args.user}".`);
            process.exit(1);
        }
    }

    const members = await db.all(
        `SELECT gm.guild_id, gm.discord_user_id, wa.wanikani_user_id,
                COALESCE(wa.username, gm.discord_user_id) AS username,
                gs.timezone AS guild_timezone
         FROM guild_members gm
         JOIN wanikani_accounts wa ON wa.discord_user_id = gm.discord_user_id
         LEFT JOIN guild_settings gs ON gs.guild_id = gm.guild_id
         ORDER BY gm.guild_id, username`
    );
    const selected = filter ? members.filter(m => filter.includes(m.discord_user_id)) : members;

    const eventsByAccount = new Map();
    let daysChanged = 0;
    let streaksChanged = 0;

    for (const m of selected) {
        const guildTz = resolveTimeZone(m.guild_timezone);
        const { timeZone } = await getEffectiveUserTimeZone(m.discord_user_id, guildTz);
        const today = botDateKey(new Date(), timeZone);

        if (!eventsByAccount.has(m.wanikani_user_id)) {
            eventsByAccount.set(m.wanikani_user_id, await loadAnswerEvents(m.wanikani_user_id));
        }
        const events = eventsByAccount.get(m.wanikani_user_id);

        const history = await db.all(
            `SELECT snapshot_date, reviews_completed, lessons_completed FROM daily_snapshots
             WHERE guild_id = ? AND discord_user_id = ?
             ORDER BY snapshot_date DESC
             LIMIT 365`,
            [m.guild_id, m.discord_user_id]
        );

        const fixes = [];
        for (const h of history) {
            if (h.snapshot_date < args.since || !(h.reviews_completed > 0)) continue;
            const answered = answeredSubjectCount(events, h.snapshot_date, timeZone);
            if (answered < h.reviews_completed) {
                fixes.push({ date: h.snapshot_date, from: h.reviews_completed, to: answered, lessons: h.lessons_completed });
                h.reviews_completed = answered;
            }
        }
        if (fixes.length === 0) continue;

        const prior = await db.get(
            `SELECT current_streak, longest_streak, last_review_date, streak_floor_date
             FROM streaks WHERE guild_id = ? AND discord_user_id = ?`,
            [m.guild_id, m.discord_user_id]
        );
        const floorDate = prior?.streak_floor_date ?? null;
        const streak = computeReviewStreak(history, today, { floorDate });
        const longest = Math.max(
            streak.currentStreak,
            Math.min(prior?.longest_streak ?? Infinity, longestStreak(history, today, floorDate))
        );

        const zeroed = fixes.filter(f => f.to === 0 && !(f.lessons > 0)).length;
        console.log(
            `${m.username} @ ${m.guild_id} (${timeZone})\n` +
            `  ${fixes.length} day(s) lowered, ${zeroed} now without any activity\n` +
            `  streak ${prior?.current_streak ?? 0} → ${streak.currentStreak}` +
            `  longest ${prior?.longest_streak ?? 0} → ${longest}`
        );
        for (const f of fixes.sort((a, b) => a.date.localeCompare(b.date))) {
            console.log(`    ${f.date}  reviews ${f.from} → ${f.to}${f.lessons ? `  (${f.lessons} lessons)` : ''}`);
        }

        daysChanged += fixes.length;
        if ((prior?.current_streak ?? 0) !== streak.currentStreak || (prior?.longest_streak ?? 0) !== longest) {
            streaksChanged++;
        }
        if (!args.apply) continue;

        for (const f of fixes) {
            await db.run(
                `UPDATE daily_snapshots SET reviews_completed = ?
                 WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date = ?`,
                [f.to, m.guild_id, m.discord_user_id, f.date]
            );
        }
        await db.run(
            `INSERT INTO streaks (
                guild_id, discord_user_id, current_streak, longest_streak, last_review_date,
                last_streak_date, offerings_available, offering_return_date, frozen_dates
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
                current_streak = excluded.current_streak,
                longest_streak = excluded.longest_streak,
                last_review_date = excluded.last_review_date,
                last_streak_date = excluded.last_streak_date,
                offerings_available = excluded.offerings_available,
                offering_return_date = excluded.offering_return_date,
                frozen_dates = excluded.frozen_dates,
                updated_at = CURRENT_TIMESTAMP`,
            [
                m.guild_id, m.discord_user_id, streak.currentStreak, longest,
                streak.lastActiveDate ?? prior?.last_review_date ?? null,
                streak.lastStreakDate, streak.offeringsAvailable, streak.offeringReturnDate,
                JSON.stringify(streak.frozenDates),
            ]
        );
    }

    console.log(
        `\n${daysChanged} snapshot day(s), ${streaksChanged} streak(s) would change.` +
        (args.apply ? ' Written.' : ' Dry run — pass --apply to write.')
    );
    await db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
