const BASE = 'https://api.wanikani.com/v2';
const WK_REVISION = '20170710';

// In-memory cache keyed by `${apiKey}::${url}` keeps the most recent
// ETag / Last-Modified / parsed body so we can send conditional headers
// and short-circuit on 304. The DB-backed cache (wk_sync_state) survives
// process restarts; this in-memory layer just avoids the DB round trip
// on hot URLs within a single process lifetime.
const _cache = new Map();

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Low-level request. Returns the full response envelope:
//   { data, etag, lastModified, dataUpdatedAt, status, notModified, totalCount, pages, raw }
// Conditional headers default to whatever's in the in-memory cache; callers
// that persist their own cache (sync workers) can override with `conditional`.
async function wkRequest(pathOrUrl, apiKey, opts = {}) {
    const {
        timeoutMs = 10000,
        retries = 1,
        conditional = null,
    } = opts;
    if (!apiKey) throw new Error('API key is required');
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`;
    const cacheKey = `${apiKey}::${url}`;
    const memCached = _cache.get(cacheKey);
    const cond = conditional ?? memCached;

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const headers = {
                'Authorization': `Bearer ${apiKey}`,
                'Wanikani-Revision': WK_REVISION,
            };
            if (cond?.etag)         headers['If-None-Match']     = cond.etag;
            if (cond?.lastModified) headers['If-Modified-Since'] = cond.lastModified;

            const res = await fetch(url, { headers, signal: ctrl.signal });
            clearTimeout(timer);

            if (res.status === 304) {
                return {
                    data: memCached?.raw ?? null,
                    etag: cond?.etag ?? null,
                    lastModified: cond?.lastModified ?? null,
                    dataUpdatedAt: memCached?.raw?.data_updated_at ?? null,
                    status: 304,
                    notModified: true,
                    totalCount: memCached?.raw?.total_count ?? null,
                    pages: memCached?.raw?.pages ?? null,
                };
            }

            if (res.status === 429) {
                clearTimeout(timer);
                const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
                if (attempt < retries) {
                    await sleep(retryAfter * 1000);
                    continue;
                }
                const body = await res.text().catch(() => '');
                throw new Error(`WaniKani API rate-limited: ${body.slice(0, 200)}`);
            }

            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`WaniKani API ${res.status}: ${body.slice(0, 200)}`);
            }

            const raw = await res.json();
            const etag = res.headers.get('ETag') ?? null;
            const lastModified = res.headers.get('Last-Modified') ?? null;
            _cache.set(cacheKey, { etag, lastModified, raw });
            return {
                data: raw,
                etag,
                lastModified,
                dataUpdatedAt: raw?.data_updated_at ?? null,
                status: res.status,
                notModified: false,
                totalCount: raw?.total_count ?? null,
                pages: raw?.pages ?? null,
            };
        } catch (err) {
            clearTimeout(timer);
            lastErr = err;
            if (attempt < retries && (err.name === 'AbortError' || err.code === 'ECONNRESET')) {
                await sleep(1000 * (attempt + 1));
                continue;
            }
            if (attempt >= retries) break;
        }
    }
    throw lastErr ?? new Error('WaniKani fetch failed');
}

// Back-compat shim — most callers just want the parsed body.
async function wkFetch(pathOrUrl, apiKey, opts) {
    const res = await wkRequest(pathOrUrl, apiKey, opts);
    return res.data;
}

// Iterate a paginated collection. Returns the accumulated items plus the
// metadata needed by sync workers (max data_updated_at seen, etc.).
async function wkRequestAllPages(pathOrUrl, apiKey, opts = {}) {
    let next = pathOrUrl;
    const items = [];
    let lastEtag = null;
    let lastLastModified = null;
    let maxDataUpdatedAt = null;
    let allNotModified = true;

    // Conditional headers only apply to the first page — subsequent pages
    // are unique URLs the server would never 304 against the same ETag.
    let conditional = opts.conditional ?? null;

    while (next) {
        const res = await wkRequest(next, apiKey, { ...opts, conditional });
        conditional = null;
        if (res.notModified) {
            // Whole collection unchanged; bail out — caller can read its cache.
            return {
                items: [],
                etag: res.etag,
                lastModified: res.lastModified,
                dataUpdatedAt: res.dataUpdatedAt,
                notModified: true,
            };
        }
        allNotModified = false;
        const body = res.data ?? {};
        items.push(...(body.data || []));
        for (const item of body.data || []) {
            const t = item?.data_updated_at;
            if (t && (!maxDataUpdatedAt || t > maxDataUpdatedAt)) maxDataUpdatedAt = t;
        }
        if (body.data_updated_at && (!maxDataUpdatedAt || body.data_updated_at > maxDataUpdatedAt)) {
            maxDataUpdatedAt = body.data_updated_at;
        }
        lastEtag = res.etag;
        lastLastModified = res.lastModified;
        next = body.pages?.next_url || null;
    }
    return {
        items,
        etag: lastEtag,
        lastModified: lastLastModified,
        dataUpdatedAt: maxDataUpdatedAt,
        notModified: allNotModified,
    };
}

async function fetchAllPages(pathOrUrl, apiKey, opts) {
    const res = await wkRequestAllPages(pathOrUrl, apiKey, opts);
    return res.items;
}

// ── cache-first helpers ───────────────────────────────────────────────────
// All helpers below accept an `account` object: { wanikani_user_id, api_token_encrypted }.
// They auto-trigger sync-on-stale via wkSync, then read from SQL. Lazy-required
// to avoid the wkSync ↔ wanikaniData circular import.
const db = require('../db');

const STALE = {
    user: 24 * 60 * 60 * 1000,
    summary: 5 * 60 * 1000,
    assignments: 30 * 60 * 1000,
    reviewStatistics: 6 * 60 * 60 * 1000,
    levelProgressions: 24 * 60 * 60 * 1000,
    subjects: 24 * 60 * 60 * 1000,
    spacedRepetitionSystems: 7 * 24 * 60 * 60 * 1000,
};

function isStale(lastSyncedAt, maxAgeMs) {
    if (!lastSyncedAt) return true;
    return Date.now() - new Date(lastSyncedAt).getTime() >= maxAgeMs;
}

async function ensureUserSynced(account, maxAgeMs = STALE.user) {
    const { loadUserSyncState, syncUser } = require('./wkSync');
    const state = await loadUserSyncState(account.wanikani_user_id, 'user');
    if (isStale(state?.lastSyncedAt, maxAgeMs)) await syncUser(account);
}
async function ensureSummarySynced(account, maxAgeMs = STALE.summary) {
    const { loadUserSyncState, syncSummary } = require('./wkSync');
    const state = await loadUserSyncState(account.wanikani_user_id, 'summary');
    if (isStale(state?.lastSyncedAt, maxAgeMs)) await syncSummary(account);
}
async function ensureAssignmentsSynced(account, maxAgeMs = STALE.assignments) {
    const { loadUserSyncState, syncAssignments } = require('./wkSync');
    const state = await loadUserSyncState(account.wanikani_user_id, 'assignments');
    if (isStale(state?.lastSyncedAt, maxAgeMs)) await syncAssignments(account);
}
async function ensureReviewStatsSynced(account, maxAgeMs = STALE.reviewStatistics) {
    const { loadUserSyncState, syncReviewStatistics } = require('./wkSync');
    const state = await loadUserSyncState(account.wanikani_user_id, 'review_statistics');
    if (isStale(state?.lastSyncedAt, maxAgeMs)) await syncReviewStatistics(account);
}
async function ensureLevelProgressionsSynced(account, maxAgeMs = STALE.levelProgressions) {
    const { loadUserSyncState, syncLevelProgressions } = require('./wkSync');
    const state = await loadUserSyncState(account.wanikani_user_id, 'level_progressions');
    if (isStale(state?.lastSyncedAt, maxAgeMs)) await syncLevelProgressions(account);
}
async function ensureSubjectsSynced(apiKey, maxAgeMs = STALE.subjects) {
    const { loadGlobalSyncState, syncSubjects } = require('./wkSync');
    const state = await loadGlobalSyncState('subjects');
    if (isStale(state?.lastSyncedAt, maxAgeMs)) await syncSubjects(apiKey);
}

async function getWaniKaniData(account) {
    await Promise.all([ensureUserSynced(account), ensureSummarySynced(account)]);
    const wkId = account.wanikani_user_id;
    const [acct, summaryRow] = await Promise.all([
        db.get(`SELECT level, current_vacation_started_at FROM wanikani_accounts WHERE wanikani_user_id = ?`, [wkId]),
        db.get(`SELECT lesson_count, review_count_now, review_count_24h, raw_json FROM wk_summary_cache WHERE wanikani_user_id = ?`, [wkId]),
    ]);
    const summary = summaryRow ? JSON.parse(summaryRow.raw_json).data : { lessons: [], reviews: [] };
    return {
        userData: {
            level: acct?.level ?? 1,
            current_vacation_started_at: acct?.current_vacation_started_at ?? null,
        },
        summary,
        pendingLessons: summaryRow?.lesson_count ?? 0,
        dueRightNow: summaryRow?.review_count_now ?? 0,
        dueNext24Hours: summaryRow?.review_count_24h ?? 0,
    };
}

async function getSrsBreakdown(account) {
    await ensureAssignmentsSynced(account);
    const rows = await db.all(
        `SELECT srs_stage, COUNT(*) AS n
         FROM wk_assignments
         WHERE wanikani_user_id = ? AND hidden = 0 AND srs_stage > 0
         GROUP BY srs_stage`,
        [account.wanikani_user_id]
    );
    const out = { apprentice: 0, guru: 0, master: 0, enlightened: 0, burned: 0 };
    for (const r of rows) {
        if (r.srs_stage <= 4) out.apprentice += r.n;
        else if (r.srs_stage <= 6) out.guru += r.n;
        else if (r.srs_stage === 7) out.master += r.n;
        else if (r.srs_stage === 8) out.enlightened += r.n;
        else if (r.srs_stage === 9) out.burned += r.n;
    }
    return out;
}

async function getBurnedCount(account) {
    await ensureAssignmentsSynced(account);
    const row = await db.get(
        `SELECT COUNT(*) AS n FROM wk_assignments
         WHERE wanikani_user_id = ? AND hidden = 0 AND srs_stage = 9`,
        [account.wanikani_user_id]
    );
    return row?.n ?? 0;
}

// Returns { reviewsCompleted, lessonsCompleted }.
// Review records are deprecated in WK API v2, so reviewsCompleted is the count
// of unique subject review-stat rows updated in the window. This tracks reviewed
// items, not repeated same-item reviews inside the same window.
async function getCompletedSince(account, isoDate) {
    const apiKey = decryptForAccount(account);
    const [assignments, reviewStats] = await Promise.all([
        fetchAllPages(
            `/assignments?updated_after=${encodeURIComponent(isoDate)}&started=true`,
            apiKey
        ),
        fetchAllPages(
            `/review_statistics?updated_after=${encodeURIComponent(isoDate)}&hidden=false`,
            apiKey
        ),
    ]);
    const cutoff = new Date(isoDate);
    let lessonsCompleted = 0;
    for (const a of assignments) {
        const startedAt = a.data?.started_at;
        if (!startedAt) continue;
        if (new Date(startedAt) >= cutoff) lessonsCompleted++;
    }
    const reviewedSubjectIds = new Set(
        reviewStats.map(s => s.data?.subject_id).filter(id => id !== undefined && id !== null)
    );
    const reviewsCompleted = reviewedSubjectIds.size;
    return { reviewsCompleted, lessonsCompleted };
}

// Backwards-compatible single-stat getters delegating to the merged fetcher.
async function getReviewsCompletedSince(account, isoDate) {
    return (await getCompletedSince(account, isoDate)).reviewsCompleted;
}
async function getLessonsCompletedSince(account, isoDate) {
    return (await getCompletedSince(account, isoDate)).lessonsCompleted;
}

// Cache-backed variant that returns the activity rows so callers can bucket
// them (e.g. into per-day snapshots). Triggers a sync if the cache is older
// than maxStaleMs (default 4 min — short enough to feel live in the 5-min
// summary loop, but rate-limited so back-to-back calls don't hammer the API).
async function getCompletedItemsSince(account, isoDate, maxStaleMs = 4 * 60 * 1000) {
    await ensureAssignmentsSynced(account, maxStaleMs);
    return db.all(
        `SELECT subject_id, started_at, data_updated_at
         FROM wk_assignments
         WHERE wanikani_user_id = ?
           AND started_at IS NOT NULL
           AND data_updated_at >= ?
           AND hidden = 0`,
        [account.wanikani_user_id, isoDate]
    );
}

async function getRandomKanjiAtLevel(apiKey, level) {
    await ensureSubjectsSynced(apiKey);
    const rows = await db.all(
        `SELECT raw_json FROM wk_subjects
         WHERE subject_type = 'kanji' AND level = ? AND hidden_at IS NULL`,
        [level]
    );
    if (!rows.length) return null;
    return JSON.parse(rows[Math.floor(Math.random() * rows.length)].raw_json);
}

async function getSubjectsByIds(apiKey, ids) {
    if (!ids.length) return [];
    await ensureSubjectsSynced(apiKey);
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.all(
        `SELECT raw_json FROM wk_subjects WHERE subject_id IN (${placeholders})`,
        ids
    );
    return rows.map(r => JSON.parse(r.raw_json));
}

async function getSubjectsPerLevel(apiKey, level) {
    await ensureSubjectsSynced(apiKey);
    const row = await db.get(
        `SELECT COUNT(*) AS n FROM wk_subjects WHERE level = ? AND hidden_at IS NULL`,
        [level]
    );
    return row?.n ?? 0;
}

// wk_assignments.level is always NULL — the WK /assignments API payload doesn't
// include the subject's level. Join wk_subjects to filter by level; use the
// subjects table for the total so the kanji 90% rule denominates against the
// full level, not just the items unlocked so far.
async function getLevelProgress(account, level) {
    await Promise.all([
        ensureAssignmentsSynced(account),
        ensureSubjectsSynced(decryptForAccount(account)),
    ]);
    const tally = async (subjectType) => {
        const totalRow = await db.get(
            `SELECT COUNT(*) AS n FROM wk_subjects
             WHERE level = ? AND subject_type = ? AND hidden_at IS NULL`,
            [level, subjectType]
        );
        const total = totalRow?.n ?? 0;
        const passRow = await db.get(
            `SELECT SUM(CASE WHEN a.passed_at IS NOT NULL THEN 1 ELSE 0 END) AS passed
             FROM wk_assignments a
             JOIN wk_subjects s ON s.subject_id = a.subject_id
             WHERE a.wanikani_user_id = ?
               AND s.level = ? AND s.subject_type = ?
               AND a.hidden = 0 AND s.hidden_at IS NULL`,
            [account.wanikani_user_id, level, subjectType]
        );
        const passed = passRow?.passed ?? 0;
        const threshold = subjectType === 'kanji' ? Math.ceil(total * 0.9) : total;
        const denominator = Math.max(1, threshold);
        return {
            total,
            passed,
            threshold,
            percent: total > 0 ? Math.min(100, Math.floor((passed / denominator) * 100)) : 0,
            remaining: Math.max(0, threshold - passed),
        };
    };
    return { kanji: await tally('kanji'), radicals: await tally('radical') };
}

// Approximation of recent accuracy. review_statistics totals are cumulative per
// item; rows updated in the window are the ones that saw activity.
async function getHitRate(account, days = 30) {
    await ensureReviewStatsSynced(account);
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    const rows = await db.all(
        `SELECT meaning_correct, meaning_incorrect, reading_correct, reading_incorrect
         FROM wk_review_statistics
         WHERE wanikani_user_id = ? AND data_updated_at >= ?`,
        [account.wanikani_user_id, since.toISOString()]
    );
    if (rows.length === 0) return null;
    let correct = 0, total = 0;
    for (const s of rows) {
        correct += (s.meaning_correct || 0) + (s.reading_correct || 0);
        total += (s.meaning_correct || 0) + (s.reading_correct || 0)
               + (s.meaning_incorrect || 0) + (s.reading_incorrect || 0);
    }
    if (total === 0) return null;
    return { hitRate: correct / total, sampleSize: rows.length, windowDays: days };
}

async function getLevelProgressions(account) {
    await ensureLevelProgressionsSynced(account);
    const rows = await db.all(
        `SELECT raw_json FROM wk_level_progressions WHERE wanikani_user_id = ?`,
        [account.wanikani_user_id]
    );
    return rows.map(r => JSON.parse(r.raw_json));
}

async function getResetsSince(apiKey, isoDate) {
    return fetchAllPages(`/resets?updated_after=${encodeURIComponent(isoDate)}`, apiKey);
}

// Hardcoded fallback for the default WK SRS, used only when wk_srs_stages
// hasn't been synced yet. Cumulative hours from current available_at until
// Guru I (stage 5).
const SRS_HOURS_TO_GURU_FALLBACK = { 1: 78, 2: 70, 3: 47, 4: 0 };

function intervalToHours(n, unit) {
    if (n == null) return 0;
    switch (unit) {
        case 'milliseconds': return n / 3_600_000;
        case 'seconds':      return n / 3600;
        case 'minutes':      return n / 60;
        case 'hours':        return n;
        case 'days':         return n * 24;
        case 'weeks':        return n * 24 * 7;
        default:             return 0;
    }
}

// Cumulative hours from `available_at` of `fromStage` to reaching Guru I (5).
// Sums interval rows for positions (fromStage, 4] in the cached SRS system.
async function cumulativeHoursToGuru(srsId, fromStage) {
    if (fromStage >= 5) return 0;
    const stages = await db.all(
        `SELECT interval, interval_unit FROM wk_srs_stages
         WHERE srs_id = ? AND position > ? AND position <= 4
         ORDER BY position`,
        [srsId, fromStage]
    );
    if (stages.length === 0) return SRS_HOURS_TO_GURU_FALLBACK[fromStage] ?? Infinity;
    let h = 0;
    for (const s of stages) h += intervalToHours(s.interval, s.interval_unit);
    return h;
}

async function getLevelUpETA(account, level) {
    await ensureAssignmentsSynced(account);
    const kanji = await db.all(
        `SELECT a.srs_stage, a.available_at, s.spaced_repetition_system_id AS srs_id
         FROM wk_assignments a
         JOIN wk_subjects s ON s.subject_id = a.subject_id
         WHERE a.wanikani_user_id = ? AND s.level = ? AND s.subject_type = 'kanji' AND a.hidden = 0`,
        [account.wanikani_user_id, level]
    );
    const total = kanji.length;
    if (total === 0) return null;
    const threshold = Math.ceil(total * 0.9);
    const now = Date.now();

    // Cache the cumulative-hours lookup per (srsId, fromStage) within this call.
    const hoursCache = new Map();
    const lookupHours = async (srsId, stage) => {
        const key = `${srsId ?? 'fallback'}::${stage}`;
        if (hoursCache.has(key)) return hoursCache.get(key);
        const h = srsId
            ? await cumulativeHoursToGuru(srsId, stage)
            : (SRS_HOURS_TO_GURU_FALLBACK[stage] ?? Infinity);
        hoursCache.set(key, h);
        return h;
    };

    const etas = await Promise.all(kanji.map(async a => {
        const stage = a.srs_stage;
        if (stage >= 5) return 0;
        if (stage === 0 || !a.available_at) return Infinity;
        const hoursLeft = await lookupHours(a.srs_id, stage);
        const base = Math.max(now, new Date(a.available_at).getTime());
        return base + hoursLeft * 3_600_000;
    }));
    etas.sort((a, b) => a - b);
    const etaMs = etas[threshold - 1];
    if (!isFinite(etaMs)) return null;
    return {
        eta: new Date(etaMs),
        passed: etas.filter(e => e === 0).length,
        total,
        threshold,
    };
}

async function getPersonalPace(account) {
    const progressions = await getLevelProgressions(account);
    const completed = progressions
        .filter(p => p.data.passed_at !== null && p.data.started_at !== null)
        .sort((a, b) => new Date(b.data.passed_at) - new Date(a.data.passed_at))
        .slice(0, 5);
    if (completed.length === 0) return null;
    const days = completed.map(p =>
        (new Date(p.data.passed_at) - new Date(p.data.started_at)) / (1000 * 60 * 60 * 24)
    );
    const avg = days.reduce((a, b) => a + b, 0) / days.length;
    return { daysPerLevel: avg, sampleSize: completed.length };
}

function decryptForAccount(account) {
    const { decrypt } = require('./crypto');
    return decrypt(account.api_token_encrypted);
}

function clearCacheForApiKey(apiKey) {
    const prefix = `${apiKey}::`;
    for (const key of _cache.keys()) {
        if (key.startsWith(prefix)) _cache.delete(key);
    }
}

module.exports = {
    // low-level
    wkRequest, wkFetch, wkRequestAllPages, fetchAllPages,
    clearCacheForApiKey,
    // cache-first high-level
    getWaniKaniData,
    getSrsBreakdown,
    getCompletedSince,
    getCompletedItemsSince,
    getReviewsCompletedSince,
    getLessonsCompletedSince,
    getBurnedCount,
    getRandomKanjiAtLevel,
    getSubjectsByIds,
    getLevelProgress,
    getHitRate,
    getLevelProgressions,
    getPersonalPace,
    getResetsSince,
    getLevelUpETA,
    getSubjectsPerLevel,
    // sync-on-stale primitives (exposed so the scheduler can pre-warm)
    ensureUserSynced,
    ensureSummarySynced,
    ensureAssignmentsSynced,
    ensureReviewStatsSynced,
    ensureLevelProgressionsSynced,
    ensureSubjectsSynced,
};
