#!/usr/bin/env node
//
// Replays every tracked user's daily_snapshots history through the WaniKani
// streak rules in helpers/streaks.js and rewrites the `streaks` rows.
//
// The scheduler already does this on its own every 5 minutes, so this script
// exists for two things: seeing *why* a streak is what it is (--trace), and
// repairing rows immediately after a deploy instead of waiting for a tick —
// which is how a streak that the old "walk back while reviews > 0" logic
// zeroed gets its frozen days back.
//
// Usage:
//   node scripts/recompute-streaks.js                    Dry run, every user
//   node scripts/recompute-streaks.js --apply            Write the new values
//   node scripts/recompute-streaks.js --user <id|name>   One user (Discord id or WK username)
//   node scripts/recompute-streaks.js --trace --user sep Day-by-day replay
//   node scripts/recompute-streaks.js --days 60          Trace window (default 45)
//
// Dry run by default: nothing is written without --apply.

const db = require('../db');
const { computeReviewStreak, MAX_OFFERINGS } = require('../helpers/streaks');
const { addDaysToDateKey, botDateKey, resolveTimeZone } = require('../helpers/botTime');
const { getEffectiveUserTimeZone } = require('../helpers/tzInfer');

function parseArgs(argv) {
    const args = { apply: false, trace: false, user: null, days: 45 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') args.apply = true;
        else if (a === '--trace') args.trace = true;
        else if (a === '--user') args.user = argv[++i];
        else if (a === '--days') args.days = Number(argv[++i]);
        else {
            console.error(`Unknown argument: ${a}`);
            process.exit(1);
        }
    }
    return args;
}

// Accepts a Discord user id, a WaniKani username, or a Discord display name
// substring — whichever the person at the terminal happens to have.
async function resolveUserFilter(needle) {
    if (/^\d{5,}$/.test(needle)) return [needle];
    const rows = await db.all(
        `SELECT DISTINCT discord_user_id FROM wanikani_accounts
         WHERE username LIKE ? COLLATE NOCASE`,
        [`%${needle}%`]
    );
    return rows.map(r => r.discord_user_id);
}

function traceReplay(history, todayKey, days, floorDate) {
    const byDate = new Map(history.map(h => [h.snapshot_date, h]));
    const lines = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = addDaysToDateKey(todayKey, -i);
        const row = byDate.get(d);
        const result = computeReviewStreak(history, d, { floorDate });
        const froze = result.frozenDates.includes(d);
        const mark = row === undefined ? '·  no snapshot'
            : ((row.reviews_completed ?? 0) + (row.lessons_completed ?? 0)) > 0
                ? `✅ ${row.reviews_completed ?? 0}r ${row.lessons_completed ?? 0}l`
                : (froze ? '👻 offering spent' : '❌ no activity');
        lines.push(`    ${d}  ${mark.padEnd(20)} streak=${String(result.currentStreak).padStart(4)}  offerings=${result.offeringsAvailable}`);
    }
    return lines;
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
        `SELECT gm.guild_id, gm.discord_user_id, COALESCE(wa.username, gm.discord_user_id) AS username,
                gs.timezone AS guild_timezone
         FROM guild_members gm
         LEFT JOIN wanikani_accounts wa ON wa.discord_user_id = gm.discord_user_id
         LEFT JOIN guild_settings gs ON gs.guild_id = gm.guild_id
         ORDER BY gm.guild_id, username`
    );

    const selected = filter ? members.filter(m => filter.includes(m.discord_user_id)) : members;
    if (args.user && selected.length === 0) {
        console.error(`"${args.user}" is not a member of any guild the bot tracks.`);
        process.exit(1);
    }

    let changed = 0;
    for (const m of selected) {

        const guildTz = resolveTimeZone(m.guild_timezone);
        const { timeZone } = await getEffectiveUserTimeZone(m.discord_user_id, guildTz);
        const today = botDateKey(new Date(), timeZone);

        const prior = await db.get(
            `SELECT current_streak, longest_streak, last_review_date, streak_floor_date
             FROM streaks WHERE guild_id = ? AND discord_user_id = ?`,
            [m.guild_id, m.discord_user_id]
        );
        const history = await db.all(
            `SELECT snapshot_date, reviews_completed, lessons_completed FROM daily_snapshots
             WHERE guild_id = ? AND discord_user_id = ?
             ORDER BY snapshot_date DESC
             LIMIT 365`,
            [m.guild_id, m.discord_user_id]
        );
        if (history.length === 0) continue;

        const floorDate = prior?.streak_floor_date ?? null;
        const streak = computeReviewStreak(history, today, { floorDate });
        const longest = Math.max(streak.currentStreak, prior?.longest_streak ?? 0);
        const before = prior?.current_streak ?? 0;
        const delta = streak.currentStreak - before;

        console.log(
            `${m.username} @ ${m.guild_id} (${timeZone})\n` +
            `  streak ${before} → ${streak.currentStreak}${delta ? `  (${delta > 0 ? '+' : ''}${delta})` : '  (unchanged)'}` +
            `  longest ${prior?.longest_streak ?? 0} → ${longest}\n` +
            `  offerings ${streak.offeringsAvailable}/${MAX_OFFERINGS}` +
            `${streak.offeringReturnDate ? `, next back ${streak.offeringReturnDate}` : ''}` +
            `${streak.frozenDates.length ? `, frozen ${streak.frozenDates.join(', ')}` : ''}` +
            `${floorDate ? `, floor ${floorDate}` : ''}`
        );
        if (args.trace) console.log(traceReplay(history, today, args.days, floorDate).join('\n'));

        if (delta !== 0) changed++;
        if (!args.apply) continue;

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

    console.log(`\n${changed} streak${changed === 1 ? '' : 's'} would change.` + (args.apply ? ' Written.' : ' Dry run — pass --apply to write.'));
    await db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
