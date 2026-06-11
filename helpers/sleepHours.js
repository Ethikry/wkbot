const db = require('../db');
const { resolveTimeZone, datePartsInTimeZone } = require('./botTime');
const { getEffectiveUserTimeZone } = require('./tzInfer');

// Reads the user's sleep window from user_reminder_settings and decides whether
// the current local hour falls inside it. Returns true if a DM should be
// suppressed right now.
//
// Time zone precedence: the user's /timezone override, else a confident
// activity-pattern inference, else the primary (earliest-joined) guild's
// timezone — same fallback convention as paceAlertJob. Falls back to the bot
// default if the user has no guild.
//
// Window is [start, end). If end <= start the window wraps midnight, e.g.
// 22 → 7 means 22, 23, 0, 1, 2, 3, 4, 5, 6.
async function isWithinSleepWindow(discordUserId, now = new Date()) {
    const prefs = await db.get(
        `SELECT sleep_start_hour, sleep_end_hour
           FROM user_reminder_settings
          WHERE discord_user_id = ?`,
        [discordUserId]
    );
    if (!prefs) return false;
    const start = prefs.sleep_start_hour;
    const end = prefs.sleep_end_hour;
    if (start === null || end === null || start === undefined || end === undefined) return false;
    if (start === end) return false;

    const tzRow = await db.get(
        `SELECT gs.timezone FROM guild_members gm
          JOIN guild_settings gs ON gs.guild_id = gm.guild_id
          WHERE gm.discord_user_id = ?
          ORDER BY gm.joined_bot_at ASC LIMIT 1`,
        [discordUserId]
    );
    const { timeZone } = await getEffectiveUserTimeZone(discordUserId, resolveTimeZone(tzRow?.timezone));
    const parts = datePartsInTimeZone(now, timeZone);
    const hour = Number(parts.hour);

    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
}

// Validates and normalizes a /setup sleep_start / sleep_end option. Accepts an
// integer 0-23 or null. Throws a user-friendly error otherwise.
function parseSleepHour(value, label) {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 23) {
        throw new Error(`${label} must be an integer between 0 and 23.`);
    }
    return n;
}

function formatSleepHours(start, end) {
    if (start === null || start === undefined || end === null || end === undefined) return 'off';
    const fmt = (h) => `${String(h).padStart(2, '0')}:00`;
    return `${fmt(start)}–${fmt(end)} (local)`;
}

module.exports = { isWithinSleepWindow, parseSleepHour, formatSleepHours };
