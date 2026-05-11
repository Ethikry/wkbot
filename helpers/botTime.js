const DEFAULT_TIME_ZONE = 'Asia/Tokyo';

function getBotTimeZone() {
    return process.env.BOT_TIMEZONE || DEFAULT_TIME_ZONE;
}

function isValidTimeZone(timeZone) {
    if (!timeZone) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return true;
    } catch {
        return false;
    }
}

function resolveTimeZone(timeZone) {
    return isValidTimeZone(timeZone) ? timeZone : getBotTimeZone();
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
    isValidTimeZone,
    resolveTimeZone,
    botDateKey,
    addDaysToDateKey,
    recentDateKeys,
    startOfBotDayUtcIso,
    zonedDateTimeToUtc,
};
