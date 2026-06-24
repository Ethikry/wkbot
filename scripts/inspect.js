#!/usr/bin/env node
//
// Read-only inspection of bot state from the terminal.
//
// Usage:
//   node scripts/inspect.js goals             Daily and long-term goals per user
//   node scripts/inspect.js setup             Linked WaniKani accounts + per-guild reminder prefs
//   node scripts/inspect.js guilds            Per-guild bot configuration
//   node scripts/inspect.js usage [options]   Slash command usage (totals + recent invocations)
//
// Safe to run while the bot is live — opens the SQLite database in read-only mode.

const path = require('path');
const sqlite3 = require('sqlite3');

const DB_PATH = path.join(__dirname, '..', 'database.sqlite');
const SUBCOMMANDS = ['goals', 'setup', 'guilds', 'usage'];

function openDb() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, err => {
            if (err) reject(err);
            else resolve(db);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}

function nameOf(row) {
    return row.display_name || row.global_name || row.discord_user_id;
}

function flag(v) {
    if (v === null || v === undefined) return '';
    return v ? 'yes' : 'no';
}

function section(title) {
    console.log(`\n=== ${title} ===`);
}

async function showGoals(db) {
    const goals = await all(db, `
        SELECT ug.discord_user_id,
               du.display_name,
               du.global_name,
               wa.username AS wk_username,
               wa.level,
               ug.target_level,
               ug.deadline,
               ug.daily_lessons,
               ug.clear_queue,
               ug.hit_rate,
               ug.notify_enabled,
               ug.updated_at
        FROM user_goals ug
        LEFT JOIN discord_users du ON du.discord_user_id = ug.discord_user_id
        LEFT JOIN wanikani_accounts wa ON wa.discord_user_id = ug.discord_user_id
        ORDER BY COALESCE(du.display_name, du.global_name, ug.discord_user_id)
    `);

    section(`Goals (${goals.length})`);
    if (goals.length === 0) {
        console.log('(none)');
    } else {
        console.table(goals.map(r => ({
            user: nameOf(r),
            wk: r.wk_username ?? '',
            'cur lvl': r.level ?? '',
            'target lvl': r.target_level ?? '',
            deadline: r.deadline ?? '',
            'daily lessons': r.daily_lessons ?? '',
            'clear queue': flag(r.clear_queue),
            'hit rate': r.hit_rate ?? '',
            notify: flag(r.notify_enabled),
            updated: r.updated_at,
        })));
    }
}

async function showSetup(db) {
    const accounts = await all(db, `
        SELECT wa.discord_user_id,
               du.display_name,
               du.global_name,
               wa.username AS wk_username,
               wa.level,
               wa.current_vacation_started_at AS vacation_since,
               wa.subscription_active,
               wa.subscription_type,
               wa.api_token_hint,
               wa.last_full_sync_at,
               wa.created_at
        FROM wanikani_accounts wa
        LEFT JOIN discord_users du ON du.discord_user_id = wa.discord_user_id
        ORDER BY COALESCE(du.display_name, du.global_name, wa.discord_user_id)
    `);

    section(`Linked WaniKani accounts (${accounts.length})`);
    if (accounts.length === 0) {
        console.log('(none)');
    } else {
        console.table(accounts.map(r => ({
            user: nameOf(r),
            wk: r.wk_username,
            lvl: r.level,
            vacation: r.vacation_since ?? '',
            sub: r.subscription_active ? (r.subscription_type ?? 'yes') : 'no',
            'api hint': r.api_token_hint ?? '',
            'last sync': r.last_full_sync_at ?? '',
            linked: r.created_at,
        })));
    }

    const reminders = await all(db, `
        SELECT rs.guild_id,
               rs.discord_user_id,
               du.display_name,
               du.global_name,
               rs.reviews_ping_enabled,
               rs.shame_enabled,
               rs.cleared_enabled,
               rs.levelup_announcement_enabled,
               rs.min_review_count,
               rs.dm_enabled,
               rs.channel_enabled,
               rs.quiet_hours_start,
               rs.quiet_hours_end,
               rs.timezone,
               gm.leaderboard_opt_out,
               gm.reminders_opt_out
        FROM reminder_settings rs
        LEFT JOIN discord_users du ON du.discord_user_id = rs.discord_user_id
        LEFT JOIN guild_members gm
            ON gm.guild_id = rs.guild_id AND gm.discord_user_id = rs.discord_user_id
        ORDER BY rs.guild_id, COALESCE(du.display_name, du.global_name, rs.discord_user_id)
    `);

    const userReminders = await all(db, `
        SELECT urs.discord_user_id,
               du.display_name,
               du.global_name,
               urs.reviews_dm_enabled,
               urs.streak_reminder_enabled,
               urs.shame_enabled
        FROM user_reminder_settings urs
        LEFT JOIN discord_users du ON du.discord_user_id = urs.discord_user_id
        ORDER BY COALESCE(du.display_name, du.global_name, urs.discord_user_id)
    `);

    section(`Per-guild user preferences (${reminders.length})`);
    if (reminders.length === 0) {
        console.log('(none)');
    } else {
        console.table(reminders.map(r => {
            const quiet = r.quiet_hours_start || r.quiet_hours_end
                ? `${r.quiet_hours_start ?? '?'}–${r.quiet_hours_end ?? '?'}`
                : '';
            return {
                guild: r.guild_id,
                user: nameOf(r),
                mention: flag(r.reviews_ping_enabled),
                shame: flag(r.shame_enabled),
                cleared: flag(r.cleared_enabled),
                levelup: flag(r.levelup_announcement_enabled),
                'min reviews': r.min_review_count,
                dm: flag(r.dm_enabled),
                channel: flag(r.channel_enabled),
                quiet,
                tz: r.timezone ?? '',
                'opt out (lb)': flag(r.leaderboard_opt_out),
                'opt out (rem)': flag(r.reminders_opt_out),
            };
        }));
    }

    section(`Personal (cross-server) reminder prefs (${userReminders.length})`);
    if (userReminders.length === 0) {
        console.log('(none)');
    } else {
        console.table(userReminders.map(r => ({
            user: nameOf(r),
            'reviews dm': flag(r.reviews_dm_enabled),
            'streak dm': flag(r.streak_reminder_enabled),
            'shame dm': flag(r.shame_enabled),
        })));
    }
}

async function showGuilds(db) {
    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const guilds = await all(db, `SELECT * FROM guild_settings ORDER BY guild_id`);

    section(`Guild settings (${guilds.length})`);
    if (guilds.length === 0) {
        console.log('(none)');
        return;
    }

    console.table(guilds.map(g => ({
        guild: g.guild_id,
        tz: g.timezone,
        'announce ch': g.announcement_channel_id ?? '',
        'reminder ch': g.reminder_channel_id ?? '',
        'leaderboard ch': g.leaderboard_channel_id ?? '',
        'mod role': g.mod_role_id ?? '',
        daily: g.daily_summary_enabled ? g.daily_summary_time : 'off',
        weekly: g.weekly_leaderboard_enabled
            ? `${DAY_NAMES[g.weekly_leaderboard_day] ?? '?'} ${g.weekly_leaderboard_time}`
            : 'off',
        levelup: flag(g.level_up_announcements_enabled),
        cleared: flag(g.reviews_cleared_announcements_enabled),
        morning: g.morning_ping_enabled ? g.morning_ping_time : 'off',
        shame: g.shame_mode_enabled ? g.shame_time : 'off',
        updated: g.updated_at,
    })));
}

function parseUsageArgs(argv) {
    const opts = { days: 7, limit: 20, recent: 10, command: null, help: false };
    const num = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const n = argv[i + 1];
        if ((a === '--days') && n) { opts.days = Math.max(1, num(n, opts.days)); i++; }
        else if ((a === '--limit') && n) { opts.limit = Math.max(1, num(n, opts.limit)); i++; }
        else if ((a === '--recent') && n) { opts.recent = Math.max(0, num(n, opts.recent)); i++; }
        else if ((a === '--command') && n) { opts.command = n.replace(/^\//, ''); i++; }
        else if (a === '--help' || a === '-h') { opts.help = true; }
    }
    return opts;
}

function commandLabel(row) {
    return `/${row.command_name}${row.subcommand_name ? ` ${row.subcommand_name}` : ''}`;
}

async function showUsage(db, argv) {
    const opts = parseUsageArgs(argv);
    if (opts.help) {
        console.log([
            'Usage: node scripts/inspect.js usage [options]',
            '',
            'Options:',
            '  --days N         Look back N days (default: 7)',
            '  --limit N        Max command summary rows (default: 20)',
            '  --recent N       Recent invocation rows (default: 10; 0 to hide)',
            '  --command NAME   Filter to one slash command (with or without leading /)',
        ].join('\n'));
        return;
    }

    const since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString();
    const where = ['started_at >= ?'];
    const params = [since];
    if (opts.command) {
        where.push('command_name = ?');
        params.push(opts.command);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    let totals, rows, recent;
    try {
        totals = await get(db, `
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
                   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
            FROM command_usage
            ${whereSql}
        `, params);

        rows = await all(db, `
            SELECT command_name, subcommand_name,
                   COUNT(*) AS total,
                   SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
                   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                   ROUND(AVG(duration_ms)) AS avg_ms,
                   MAX(started_at) AS last_used_at
            FROM command_usage
            ${whereSql}
            GROUP BY command_name, subcommand_name
            ORDER BY total DESC, command_name ASC
            LIMIT ?
        `, [...params, opts.limit]);

        if (opts.recent > 0) {
            recent = await all(db, `
                SELECT command_name, subcommand_name, guild_id, discord_user_id,
                       started_at, status, duration_ms, error
                FROM command_usage
                ${whereSql}
                ORDER BY started_at DESC
                LIMIT ?
            `, [...params, opts.recent]);
        }
    } catch (err) {
        if (/no such table/i.test(err.message || '')) {
            console.error('command_usage table not found — has the bot been started on a build that includes the usage-tracking migration (v7)?');
            return;
        }
        throw err;
    }

    section(`Command usage since ${since}`);
    console.log(`Total: ${totals.total || 0} | Success: ${totals.success || 0} | Failed: ${totals.failed || 0}`);

    if (rows.length === 0) {
        console.log('(no command usage in window)');
    } else {
        console.table(rows.map(r => ({
            command: commandLabel(r),
            total: r.total,
            ok: r.success || 0,
            fail: r.failed || 0,
            'avg ms': r.avg_ms ?? '',
            'last used': r.last_used_at,
        })));
    }

    if (opts.recent > 0 && recent && recent.length > 0) {
        section(`Recent invocations (${recent.length})`);
        console.table(recent.map(r => ({
            time: r.started_at,
            command: commandLabel(r),
            status: r.status,
            ms: r.duration_ms ?? '',
            guild: r.guild_id ?? 'dm',
            user: r.discord_user_id,
            error: r.error ?? '',
        })));
    }
}

async function main() {
    const cmd = process.argv[2];
    if (!cmd || !SUBCOMMANDS.includes(cmd)) {
        console.error(`Usage: node scripts/inspect.js <${SUBCOMMANDS.join('|')}> [options]`);
        process.exit(1);
    }
    const rest = process.argv.slice(3);

    const db = await openDb();
    try {
        if (cmd === 'goals') await showGoals(db);
        else if (cmd === 'setup') await showSetup(db);
        else if (cmd === 'guilds') await showGuilds(db);
        else if (cmd === 'usage') await showUsage(db, rest);
    } finally {
        await new Promise(resolve => db.close(() => resolve()));
    }
}

main().catch(err => {
    console.error('inspect failed:', err);
    process.exit(1);
});
