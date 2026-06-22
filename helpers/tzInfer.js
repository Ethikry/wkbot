const db = require('../db');
const { resolveTimeZone, isValidTimeZone } = require('./botTime');

// Effective zone for per-user features: explicit /timezone override first,
// then the caller's fallback (usually the guild tz, which defaults to JST).
async function getEffectiveUserTimeZone(discordUserId, fallbackTz) {
    const prefs = await db.get(
        `SELECT timezone FROM user_reminder_settings WHERE discord_user_id = ?`,
        [discordUserId]
    );
    if (prefs?.timezone && isValidTimeZone(prefs.timezone)) {
        return { timeZone: resolveTimeZone(prefs.timezone), source: 'override' };
    }
    return { timeZone: resolveTimeZone(fallbackTz), source: 'fallback' };
}

module.exports = { getEffectiveUserTimeZone };
