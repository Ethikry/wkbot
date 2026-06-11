const db = require('../db');
const { resolveTimeZone, isValidTimeZone, getTimeZoneOffsetMs } = require('./botTime');

// Infers a user's timezone from activity patterns — no user input needed.
//
// Neither Discord nor WaniKani exposes a timezone, but we already record when
// the user is awake: WK stamps every assignment mutation server-side
// (wk_assignments.data_updated_at = the moment a review was answered), the
// 5-minute queue poll catches queue-size drops, and command_usage logs every
// slash command. Counting distinct (day, hour) "active slots" across those
// sources gives a 24-bin UTC histogram; the quietest contiguous 7 hours is
// sleep, and assuming the sleep midpoint sits around 3:30am local yields a
// UTC offset. The stored Discord locale then snaps that raw offset to a real
// IANA zone so DST keeps working without re-inference.
//
// Effective-zone precedence everywhere: explicit /timezone override >
// confident inference > caller-supplied fallback (usually the guild tz).

const WINDOW_DAYS = 56;
const SLEEP_WINDOW_HOURS = 7;
// Assumed local sleep midpoint: 3:30am (sleep ~midnight–7am).
const SLEEP_MIDPOINT_LOCAL = 3.5;
// Minimum distinct active (day, hour) slots before an inference is persisted.
const MIN_ACTIVE_SLOTS = 60;
// Consumers should ignore inferences below this confidence.
const CONFIDENCE_THRESHOLD = 0.6;
// Mirrors BULK_UPDATE_SECOND_THRESHOLD in scheduler.js: vacation-mode toggles
// re-stamp every assignment in the same second; no human reviews that fast.
const BULK_SECOND_THRESHOLD = 50;

// Candidate IANA zones per locale region, ordered roughly by population so
// offset ties break toward the likelier zone. A locale like "en-US" plus a
// raw offset of -5 picks America/New_York instead of the DST-blind Etc/GMT+5.
const REGION_ZONES = {
    US: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],
    CA: ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax', 'America/St_Johns'],
    MX: ['America/Mexico_City', 'America/Tijuana', 'America/Cancun'],
    BR: ['America/Sao_Paulo', 'America/Manaus', 'America/Fortaleza'],
    GB: ['Europe/London'],
    IE: ['Europe/Dublin'],
    FR: ['Europe/Paris'],
    DE: ['Europe/Berlin'],
    ES: ['Europe/Madrid', 'Atlantic/Canary'],
    IT: ['Europe/Rome'],
    NL: ['Europe/Amsterdam'],
    SE: ['Europe/Stockholm'],
    NO: ['Europe/Oslo'],
    DK: ['Europe/Copenhagen'],
    FI: ['Europe/Helsinki'],
    PL: ['Europe/Warsaw'],
    PT: ['Europe/Lisbon'],
    RU: ['Europe/Moscow', 'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Asia/Vladivostok'],
    UA: ['Europe/Kyiv'],
    TR: ['Europe/Istanbul'],
    JP: ['Asia/Tokyo'],
    KR: ['Asia/Seoul'],
    CN: ['Asia/Shanghai'],
    TW: ['Asia/Taipei'],
    HK: ['Asia/Hong_Kong'],
    SG: ['Asia/Singapore'],
    TH: ['Asia/Bangkok'],
    VN: ['Asia/Ho_Chi_Minh'],
    PH: ['Asia/Manila'],
    ID: ['Asia/Jakarta', 'Asia/Makassar'],
    IN: ['Asia/Kolkata'],
    AU: ['Australia/Sydney', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Perth'],
    NZ: ['Pacific/Auckland'],
    AR: ['America/Argentina/Buenos_Aires'],
    CL: ['America/Santiago'],
    CO: ['America/Bogota'],
    PE: ['America/Lima'],
    ZA: ['Africa/Johannesburg'],
    EG: ['Africa/Cairo'],
    IL: ['Asia/Jerusalem'],
    SA: ['Asia/Riyadh'],
    AE: ['Asia/Dubai'],
};

// Language-only locales (no region part) that still imply a region strongly.
const LANGUAGE_REGIONS = {
    ja: 'JP', ko: 'KR', th: 'TH', vi: 'VN', tr: 'TR', pl: 'PL',
    sv: 'SE', no: 'NO', da: 'DK', fi: 'FI', nl: 'NL', uk: 'UA',
    el: 'GR', he: 'IL', hi: 'IN', id: 'ID', cs: 'CZ', hu: 'HU', ro: 'RO',
};

function hourSlotKey(iso) {
    // "2026-06-10T14:23:11.000Z" -> "2026-06-10T14" (UTC day + hour)
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 13);
}

// 24-bin UTC-hour histogram of distinct active (day, hour) slots over the
// trailing window. Distinct slots rather than raw events so a 300-review
// marathon counts the same as a 10-review session in the same hour.
async function buildActivityHistogram(discordUserId, wanikaniUserId, windowDays = WINDOW_DAYS) {
    const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const slots = new Set();

    if (wanikaniUserId) {
        const rows = await db.all(
            `SELECT data_updated_at FROM wk_assignments
             WHERE wanikani_user_id = ? AND data_updated_at >= ? AND hidden = 0`,
            [wanikaniUserId, sinceIso]
        );
        // Drop bulk re-stamps (vacation toggles) before slotting.
        const perSecond = new Map();
        for (const r of rows) {
            const sec = r.data_updated_at.slice(0, 19);
            perSecond.set(sec, (perSecond.get(sec) || 0) + 1);
        }
        for (const r of rows) {
            if (perSecond.get(r.data_updated_at.slice(0, 19)) > BULK_SECOND_THRESHOLD) continue;
            const key = hourSlotKey(r.data_updated_at);
            if (key) slots.add(key);
        }
    }

    // Queue-size drops between consecutive 5-minute polls = user was active.
    const queueRows = await db.all(
        `SELECT guild_id, recorded_at, queue_size FROM queue_history
         WHERE discord_user_id = ? AND recorded_at >= ?
         ORDER BY guild_id, recorded_at`,
        [discordUserId, sinceIso]
    );
    let prev = null;
    for (const r of queueRows) {
        if (prev && prev.guild_id === r.guild_id && r.queue_size < prev.queue_size) {
            const key = hourSlotKey(r.recorded_at);
            if (key) slots.add(key);
        }
        prev = r;
    }

    const usageRows = await db.all(
        `SELECT started_at FROM command_usage
         WHERE discord_user_id = ? AND started_at >= ?`,
        [discordUserId, sinceIso]
    );
    for (const r of usageRows) {
        const key = hourSlotKey(r.started_at);
        if (key) slots.add(key);
    }

    const histogram = new Array(24).fill(0);
    for (const key of slots) histogram[Number(key.slice(11, 13))]++;
    return histogram;
}

// Slide a 7-hour window over the histogram, take the quietest as sleep, and
// back out the UTC offset from the assumed local sleep midpoint. Returns
// { offset, confidence, sleepStartUtc, totalSlots } — offset is null when
// there isn't enough signal.
function inferUtcOffset(histogram) {
    const totalSlots = histogram.reduce((a, b) => a + b, 0);
    if (totalSlots < MIN_ACTIVE_SLOTS) {
        return { offset: null, confidence: 0, sleepStartUtc: null, totalSlots };
    }

    let bestSum = Infinity;
    const sums = [];
    for (let start = 0; start < 24; start++) {
        let sum = 0;
        for (let i = 0; i < SLEEP_WINDOW_HOURS; i++) sum += histogram[(start + i) % 24];
        sums.push(sum);
        if (sum < bestSum) bestSum = sum;
    }
    // A quiet gap longer than the window produces a run of tied minima;
    // taking the first would bias the sleep estimate toward its early edge
    // (a 9h gap read as 7h shifts the offset a full hour). Center the window
    // in the longest run of ties instead. The run can wrap midnight, so scan
    // two laps and track the longest stretch.
    let bestStart = 0;
    let runStart = -1;
    let bestRunLen = 0;
    for (let i = 0; i < 48; i++) {
        if (sums[i % 24] === bestSum) {
            if (runStart === -1) runStart = i;
            const len = i - runStart + 1;
            if (len > bestRunLen) {
                bestRunLen = Math.min(len, 24);
                bestStart = (runStart + Math.floor((len - 1) / 2)) % 24;
            }
        } else {
            runStart = -1;
        }
    }

    const sleepMidpointUtc = (bestStart + SLEEP_WINDOW_HOURS / 2) % 24;
    let offset = Math.round(SLEEP_MIDPOINT_LOCAL - sleepMidpointUtc);
    if (offset < -11) offset += 24;
    if (offset > 13) offset -= 24;

    // Contrast: how empty the trough is vs. an average waking hour. A flat
    // histogram (activity around the clock, or a bot-shaped pattern) scores
    // near 0; a clean sleep gap scores near 1.
    const wakingAvg = (totalSlots - bestSum) / (24 - SLEEP_WINDOW_HOURS);
    const troughAvg = bestSum / SLEEP_WINDOW_HOURS;
    const contrast = wakingAvg > 0 ? 1 - troughAvg / wakingAvg : 0;
    // Sample factor saturates at ~3 active slots/day over the window.
    const sampleFactor = Math.min(1, totalSlots / (WINDOW_DAYS * 3));
    const confidence = Math.max(0, Math.min(1, contrast * (0.5 + 0.5 * sampleFactor)));

    return { offset, confidence, sleepStartUtc: bestStart, totalSlots };
}

function currentOffsetHours(zone) {
    // getTimeZoneOffsetMs works from second-precision date parts, so the raw
    // value sits up to a second off a clean hour; quantize to quarter hours
    // (the finest real zone granularity, e.g. Nepal +5:45).
    const raw = getTimeZoneOffsetMs(new Date(), zone) / 3600000;
    return Math.round(raw * 4) / 4;
}

// Map a raw UTC offset to an IANA zone, preferring zones plausible for the
// user's Discord locale. Falls back to Etc/GMT±N — note the POSIX sign flip:
// Etc/GMT-9 means UTC+9.
function snapOffsetToIana(offset, locale) {
    if (offset === null) return null;

    let region = null;
    if (locale) {
        const parts = String(locale).split('-');
        if (parts.length > 1) region = parts[parts.length - 1].toUpperCase();
        else region = LANGUAGE_REGIONS[parts[0].toLowerCase()] ?? null;
    }

    const candidates = (region && REGION_ZONES[region]) || [];
    for (const zone of candidates) {
        if (Math.abs(currentOffsetHours(zone) - offset) <= 0.5) return zone;
    }
    // No locale match — try the bigger pool so common offsets still land on a
    // DST-aware zone (e.g. -5 → New York) instead of a fixed Etc zone.
    for (const zones of Object.values(REGION_ZONES)) {
        for (const zone of zones) {
            if (Math.abs(currentOffsetHours(zone) - offset) <= 0.25) return zone;
        }
    }
    const etc = `Etc/GMT${offset <= 0 ? '+' : '-'}${Math.abs(offset)}`;
    return isValidTimeZone(etc) ? etc : null;
}

// Infer and persist for one user. Returns the inference result (also when
// below threshold, for the debug script) — but only persists when the sample
// floor is met, so a confident stored value is never replaced by noise.
async function inferAndStoreUserTimeZone(discordUserId, wanikaniUserId) {
    const localeRow = await db.get(
        `SELECT locale FROM discord_users WHERE discord_user_id = ?`,
        [discordUserId]
    );
    const histogram = await buildActivityHistogram(discordUserId, wanikaniUserId);
    const result = inferUtcOffset(histogram);
    const zone = snapOffsetToIana(result.offset, localeRow?.locale);

    if (zone && result.totalSlots >= MIN_ACTIVE_SLOTS) {
        await db.run(
            `INSERT INTO user_reminder_settings (discord_user_id, inferred_timezone, inferred_tz_confidence, inferred_tz_updated_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(discord_user_id) DO UPDATE SET
                inferred_timezone = excluded.inferred_timezone,
                inferred_tz_confidence = excluded.inferred_tz_confidence,
                inferred_tz_updated_at = excluded.inferred_tz_updated_at,
                updated_at = CURRENT_TIMESTAMP`,
            [discordUserId, zone, result.confidence]
        );
    }
    return { ...result, zone, locale: localeRow?.locale ?? null, histogram };
}

// Effective zone for per-user features: explicit /timezone override first,
// then a confident inference, then the caller's fallback (usually guild tz).
async function getEffectiveUserTimeZone(discordUserId, fallbackTz) {
    const prefs = await db.get(
        `SELECT timezone, inferred_timezone, inferred_tz_confidence
         FROM user_reminder_settings WHERE discord_user_id = ?`,
        [discordUserId]
    );
    if (prefs?.timezone && isValidTimeZone(prefs.timezone)) {
        return { timeZone: resolveTimeZone(prefs.timezone), source: 'override' };
    }
    if (
        prefs?.inferred_timezone &&
        (prefs.inferred_tz_confidence ?? 0) >= CONFIDENCE_THRESHOLD &&
        isValidTimeZone(prefs.inferred_timezone)
    ) {
        return {
            timeZone: resolveTimeZone(prefs.inferred_timezone),
            source: 'inferred',
            confidence: prefs.inferred_tz_confidence,
        };
    }
    return { timeZone: resolveTimeZone(fallbackTz), source: 'fallback' };
}

module.exports = {
    buildActivityHistogram,
    inferUtcOffset,
    snapOffsetToIana,
    inferAndStoreUserTimeZone,
    getEffectiveUserTimeZone,
    CONFIDENCE_THRESHOLD,
    MIN_ACTIVE_SLOTS,
};
