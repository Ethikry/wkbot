#!/usr/bin/env node
//
// Renders the daily recap embed for a guild without posting it — useful for
// checking layout and digest content before the nightly job runs.
//
// Usage:
//   node scripts/preview-daily.js <guild_id> [date_key]
//
// date_key defaults to yesterday in the guild's configured timezone (the day
// the real dailyJob would recap at its default midnight schedule). Display
// names resolve to "Unknown" since there is no Discord client — pass real
// names through the live bot to see them.
//
// Read-only with one exception: it does NOT call finalizeGoalDay, so goal_met
// markers reflect whatever the last real dailyJob run wrote.

const db = require('../db');
const { buildDailyRecap } = require('../helpers/dailyRecap');
const { resolveTimeZone, botDateKey, addDaysToDateKey } = require('../helpers/botTime');

async function main() {
    const [guildId, dateArg] = process.argv.slice(2);
    if (!guildId) {
        console.error('Usage: node scripts/preview-daily.js <guild_id> [YYYY-MM-DD]');
        process.exit(1);
    }

    await db.init();

    const settings = await db.get(`SELECT timezone FROM guild_settings WHERE guild_id = ?`, [guildId]);
    if (!settings) {
        console.error(`No guild_settings row for guild ${guildId}`);
        process.exit(1);
    }
    const tz = resolveTimeZone(settings.timezone);
    const dateKey = dateArg ?? addDaysToDateKey(botDateKey(new Date(), tz), -1);

    // No Discord client here — a stub guild makes every name "Unknown".
    const stubGuild = { members: { fetch: async () => null } };

    const recap = await buildDailyRecap(guildId, stubGuild, tz, dateKey);
    if (!recap) {
        console.log('(no recap — guild has no linked members)');
    } else {
        console.log(JSON.stringify(recap, null, 2));
        const totalChars = recap.title.length + recap.description.length
            + recap.fields.reduce((a, f) => a + f.name.length + f.value.length, 0);
        console.log(`\n— ${recap.fields.length} fields, ~${totalChars} chars (embed limit 6000)`);
    }
    await db.close();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
