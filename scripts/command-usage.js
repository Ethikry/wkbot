#!/usr/bin/env node
const db = require('../db');

function parseArgs(argv) {
    const opts = {
        days: 7,
        limit: 20,
        recent: 10,
        command: null,
    };
    const numberArg = (value, fallback) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === '--days' && next) {
            opts.days = Math.max(1, numberArg(next, opts.days));
            i++;
        } else if (arg === '--limit' && next) {
            opts.limit = Math.max(1, numberArg(next, opts.limit));
            i++;
        } else if (arg === '--recent' && next) {
            opts.recent = Math.max(0, numberArg(next, opts.recent));
            i++;
        } else if (arg === '--command' && next) {
            opts.command = next.replace(/^\//, '');
            i++;
        } else if (arg === '--help' || arg === '-h') {
            opts.help = true;
        }
    }
    return opts;
}

function printHelp() {
    console.log([
        'Usage: npm run usage -- [options]',
        '',
        'Options:',
        '  --days N       Look back N days (default: 7)',
        '  --limit N      Max command summary rows (default: 20)',
        '  --recent N     Recent invocation rows (default: 10, use 0 to hide)',
        '  --command NAME Filter to one slash command, with or without leading /',
    ].join('\n'));
}

function pad(value, width) {
    const s = String(value ?? '');
    return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function commandLabel(row) {
    return `/${row.command_name}${row.subcommand_name ? ` ${row.subcommand_name}` : ''}`;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        printHelp();
        return;
    }

    await db.init();
    const since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString();
    const where = ['started_at >= ?'];
    const params = [since];
    if (opts.command) {
        where.push('command_name = ?');
        params.push(opts.command);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const totals = await db.get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM command_usage
         ${whereSql}`,
        params
    );

    console.log(`Command usage since ${since}`);
    console.log(`Total: ${totals.total || 0} | Success: ${totals.success || 0} | Failed: ${totals.failed || 0}`);
    console.log('');

    const rows = await db.all(
        `SELECT command_name, subcommand_name,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                ROUND(AVG(duration_ms)) AS avg_ms,
                MAX(started_at) AS last_used_at
         FROM command_usage
         ${whereSql}
         GROUP BY command_name, subcommand_name
         ORDER BY total DESC, command_name ASC
         LIMIT ?`,
        [...params, opts.limit]
    );

    if (rows.length === 0) {
        console.log('No command usage found.');
    } else {
        console.log(`${pad('Command', 24)} ${pad('Total', 7)} ${pad('OK', 7)} ${pad('Fail', 7)} ${pad('Avg ms', 8)} Last used`);
        for (const row of rows) {
            console.log([
                pad(commandLabel(row), 24),
                pad(row.total, 7),
                pad(row.success || 0, 7),
                pad(row.failed || 0, 7),
                pad(row.avg_ms ?? '-', 8),
                row.last_used_at,
            ].join(' '));
        }
    }

    if (opts.recent > 0) {
        const recent = await db.all(
            `SELECT command_name, subcommand_name, guild_id, discord_user_id,
                    started_at, status, duration_ms, error
             FROM command_usage
             ${whereSql}
             ORDER BY started_at DESC
             LIMIT ?`,
            [...params, opts.recent]
        );
        console.log('');
        console.log(`Recent (${recent.length})`);
        for (const row of recent) {
            const bits = [
                row.started_at,
                pad(row.status, 7),
                pad(commandLabel(row), 24),
                `${row.duration_ms ?? '-'}ms`,
                `guild=${row.guild_id ?? 'dm'}`,
                `user=${row.discord_user_id}`,
            ];
            if (row.error) bits.push(`error=${row.error}`);
            console.log(bits.join(' | '));
        }
    }
}

main()
    .catch(err => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => db.close());
