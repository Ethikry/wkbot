const DEFAULT_TIME_ZONE = 'Asia/Tokyo';

function getBotTimeZone() {
    return process.env.BOT_TIMEZONE || DEFAULT_TIME_ZONE;
}

// Common timezone abbreviations users type instead of IANA names. Each maps to
// an IANA zone that handles DST correctly (e.g. PST and PDT both → Los Angeles).
const TIME_ZONE_ABBREVIATIONS = {
    UTC: 'UTC',
    GMT: 'Etc/GMT',
    // North America
    PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PT: 'America/Los_Angeles',
    MST: 'America/Denver',      MDT: 'America/Denver',      MT: 'America/Denver',
    CST: 'America/Chicago',     CDT: 'America/Chicago',     CT: 'America/Chicago',
    EST: 'America/New_York',    EDT: 'America/New_York',    ET: 'America/New_York',
    AKST: 'America/Anchorage',  AKDT: 'America/Anchorage',
    HST: 'Pacific/Honolulu',
    AST: 'America/Halifax',     ADT: 'America/Halifax',
    NST: 'America/St_Johns',    NDT: 'America/St_Johns',
    // Europe
    BST: 'Europe/London',
    WET: 'Europe/Lisbon',       WEST: 'Europe/Lisbon',
    CET: 'Europe/Paris',        CEST: 'Europe/Paris',
    EET: 'Europe/Helsinki',     EEST: 'Europe/Helsinki',
    MSK: 'Europe/Moscow',
    // Asia / Pacific
    JST: 'Asia/Tokyo',
    KST: 'Asia/Seoul',
    HKT: 'Asia/Hong_Kong',
    SGT: 'Asia/Singapore',
    IST: 'Asia/Kolkata',
    PHT: 'Asia/Manila',
    ICT: 'Asia/Bangkok',
    AEST: 'Australia/Sydney',   AEDT: 'Australia/Sydney',
    ACST: 'Australia/Adelaide', ACDT: 'Australia/Adelaide',
    AWST: 'Australia/Perth',
    NZST: 'Pacific/Auckland',   NZDT: 'Pacific/Auckland',
};

function normalizeTimeZone(timeZone) {
    if (!timeZone) return timeZone;
    const upper = timeZone.toUpperCase();
    return TIME_ZONE_ABBREVIATIONS[upper] ?? timeZone;
}

function isValidTimeZone(timeZone) {
    if (!timeZone) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: normalizeTimeZone(timeZone) });
        return true;
    } catch {
        return false;
    }
}

function resolveTimeZone(timeZone) {
    const normalized = normalizeTimeZone(timeZone);
    return isValidTimeZone(normalized) ? normalized : getBotTimeZone();
}

function datePartsInTimeZone(date = new Date(), timeZone = getBotTimeZone()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const out = {};
    for (const part of parts) {
        if (part.type !== 'literal') out[part.type] = part.value;
    }
    return out;
}

function botDateKey(date = new Date(), timeZone = getBotTimeZone()) {
    const p = datePartsInTimeZone(date, timeZone);
    return `${p.year}-${p.month}-${p.day}`;
}

function addDaysToDateKey(dateKey, deltaDays) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day + deltaDays, 12, 0, 0));
    return d.toISOString().slice(0, 10);
}

function recentDateKeys(days = 30, timeZone = getBotTimeZone(), now = new Date()) {
    const today = botDateKey(now, timeZone);
    const keys = [];
    for (let i = days - 1; i >= 0; i--) {
        keys.push(addDaysToDateKey(today, -i));
    }
    return keys;
}

function getTimeZoneOffsetMs(date, timeZone = getBotTimeZone()) {
    const p = datePartsInTimeZone(date, timeZone);
    const asUtc = Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
        Number(p.second)
    );
    return asUtc - date.getTime();
}

function zonedDateTimeToUtc(dateKey, time = '00:00:00', timeZone = getBotTimeZone()) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const [hour, minute, second] = time.split(':').map(Number);
    const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second || 0);
    let utcMs = localAsUtc - getTimeZoneOffsetMs(new Date(localAsUtc), timeZone);
    utcMs = localAsUtc - getTimeZoneOffsetMs(new Date(utcMs), timeZone);
    return new Date(utcMs);
}

function startOfBotDayUtcIso(dateKey = botDateKey(), timeZone = getBotTimeZone()) {
    return zonedDateTimeToUtc(dateKey, '00:00:00', timeZone).toISOString();
}

module.exports = {
    DEFAULT_TIME_ZONE,
    getBotTimeZone,
    normalizeTimeZone,
    isValidTimeZone,
    resolveTimeZone,
    botDateKey,
    addDaysToDateKey,
    recentDateKeys,
    startOfBotDayUtcIso,
    zonedDateTimeToUtc,
};
