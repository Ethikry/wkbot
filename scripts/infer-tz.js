#!/usr/bin/env node
// Prints each linked user's activity histogram and inferred timezone without
// persisting anything. Sanity-check the inference against users whose real
// timezone you know before trusting it.
//
//   node scripts/infer-tz.js [discord_user_id]

require('dotenv').config();
const db = require('../db');
const { buildActivityHistogram, inferUtcOffset, snapOffsetToIana } = require('../helpers/tzInfer');

function renderHistogram(histogram) {
    const max = Math.max(...histogram, 1);
    return histogram
        .map((n, h) => `    ${String(h).padStart(2, '0')}:00 UTC ${'█'.repeat(Math.round((n / max) * 40)).padEnd(40)} ${n}`)
        .join('\n');
}

async function main() {
    await db.init();
    const filterId = process.argv[2] ?? null;
    const accounts = await db.all(
        `SELECT wa.wanikani_user_id, wa.discord_user_id, wa.username, du.locale
         FROM wanikani_accounts wa
         LEFT JOIN discord_users du ON du.discord_user_id = wa.discord_user_id
         ${filterId ? 'WHERE wa.discord_user_id = ?' : ''}`,
        filterId ? [filterId] : []
    );
    if (accounts.length === 0) {
        console.log(filterId ? `No linked account for ${filterId}` : 'No linked accounts.');
        return;
    }

    for (const account of accounts) {
        const histogram = await buildActivityHistogram(account.discord_user_id, account.wanikani_user_id);
        const result = inferUtcOffset(histogram);
        const zone = snapOffsetToIana(result.offset, account.locale);

        console.log(`\n${account.username} (discord ${account.discord_user_id}, locale ${account.locale ?? 'unknown'})`);
        console.log(renderHistogram(histogram));
        if (result.offset === null) {
            console.log(`    → insufficient data (${result.totalSlots} active slots, need 60)`);
        } else {
            console.log(`    → sleep ${String(result.sleepStartUtc).padStart(2, '0')}:00–${String((result.sleepStartUtc + 7) % 24).padStart(2, '0')}:00 UTC, offset UTC${result.offset >= 0 ? '+' : ''}${result.offset}, zone ${zone}, confidence ${result.confidence.toFixed(2)} (${result.totalSlots} slots)`);
        }
    }
}

main()
    .catch(err => { console.error(err); process.exitCode = 1; })
    .finally(() => db.close());
