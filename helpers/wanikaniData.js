const BASE = 'https://api.wanikani.com/v2';
const WK_REVISION = '20170710';

// In-memory cache of { etag, lastModified, data } keyed by url.
// Lets us send If-None-Match / If-Modified-Since and skip re-parsing on 304.
const _cache = new Map();

async function wkFetch(pathOrUrl, apiKey, { timeoutMs = 10000, retries = 1 } = {}) {
    if (!apiKey) throw new Error('API key is required');
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`;
    // Cache is keyed by url + apiKey so different users don't share entries.
    const cacheKey = `${apiKey}::${url}`;
    const cached = _cache.get(cacheKey);

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const headers = {
                'Authorization': `Bearer ${apiKey}`,
                'Wanikani-Revision': WK_REVISION,
            };
            if (cached?.etag)         headers['If-None-Match']     = cached.etag;
            if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

            const res = await fetch(url, { headers, signal: ctrl.signal });
            clearTimeout(timer);

            if (res.status === 304) {
                return cached.data;
            }

            if (res.status === 429) {
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

            const data = await res.json();
            _cache.set(cacheKey, {
                etag:         res.headers.get('ETag') ?? null,
                lastModified: res.headers.get('Last-Modified') ?? null,
                data,
            });
            return data;
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

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function fetchAllPages(pathOrUrl, apiKey, opts) {
    let next = pathOrUrl;
    const items = [];
    while (next) {
        const res = await wkFetch(next, apiKey, opts);
        items.push(...(res.data || []));
        next = res.pages?.next_url || null;
    }
    return items;
}

async function getWaniKaniData(apiKey) {
    const [userJson, summaryJson] = await Promise.all([
        wkFetch('/user', apiKey),
        wkFetch('/summary', apiKey),
    ]);
    const userData = userJson.data;
    const summary = summaryJson.data;

    const pendingLessons = summary.lessons?.[0]?.subject_ids?.length ?? 0;
    const now = new Date();

    const dueRightNow = (summary.reviews || [])
        .filter(r => new Date(r.available_at) <= now)
        .reduce((acc, r) => acc + r.subject_ids.length, 0);

    const dueNext24Hours = (summary.reviews || [])
        .reduce((acc, r) => acc + r.subject_ids.length, 0);

    return {
        userData,
        summary,
        pendingLessons,
        dueRightNow,
        dueNext24Hours,
    };
}

async function getSrsBreakdown(apiKey) {
    const [appr, guru, master, enl, burned] = await Promise.all([
        wkFetch('/assignments?srs_stages=1,2,3,4&hidden=false', apiKey),
        wkFetch('/assignments?srs_stages=5,6&hidden=false', apiKey),
        wkFetch('/assignments?srs_stages=7&hidden=false', apiKey),
        wkFetch('/assignments?srs_stages=8&hidden=false', apiKey),
        wkFetch('/assignments?srs_stages=9&hidden=false', apiKey),
    ]);
    return {
        apprentice: appr.total_count,
        guru: guru.total_count,
        master: master.total_count,
        enlightened: enl.total_count,
        burned: burned.total_count,
    };
}

async function getReviewsCompletedSince(apiKey, isoDate) {
    // GET /reviews is deprecated and returns empty data; derive count from assignments instead.
    // Assignments updated after the cutoff that were already started before the cutoff = reviews done.
    const assignments = await fetchAllPages(
        `/assignments?updated_after=${encodeURIComponent(isoDate)}&started=true`,
        apiKey
    );
    const cutoff = new Date(isoDate);
    return assignments.filter(a =>
        a.data.started_at && new Date(a.data.started_at) < cutoff
    ).length;
}

async function getLessonsCompletedSince(apiKey, isoDate) {
    // WaniKani has no `started_after` filter; use `updated_after` + client-side check on started_at
    const assignments = await fetchAllPages(
        `/assignments?updated_after=${encodeURIComponent(isoDate)}&started=true`,
        apiKey
    );
    const cutoff = new Date(isoDate);
    return assignments.filter(a => a.data.started_at && new Date(a.data.started_at) >= cutoff).length;
}

async function getBurnedCount(apiKey) {
    const res = await wkFetch('/assignments?srs_stages=9&hidden=false', apiKey);
    return res.total_count ?? 0;
}

async function getRandomKanjiAtLevel(apiKey, level) {
    const subjects = await fetchAllPages(`/subjects?types=kanji&levels=${level}`, apiKey);
    if (!subjects.length) return null;
    return subjects[Math.floor(Math.random() * subjects.length)];
}


async function getSubjectsByIds(apiKey, ids) {
    if (!ids.length) return [];
    const collected = [];
    const chunkSize = 100;
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const items = await fetchAllPages(`/subjects?ids=${chunk.join(',')}`, apiKey);
        collected.push(...items);
    }
    return collected;
}

async function getLevelProgress(apiKey, level) {
    const [kanji, radicals] = await Promise.all([
        fetchAllPages(`/assignments?levels=${level}&subject_types=kanji&hidden=false`, apiKey),
        fetchAllPages(`/assignments?levels=${level}&subject_types=radical&hidden=false`, apiKey),
    ]);
    const tally = (list) => {
        const total = list.length;
        const passed = list.filter(a => a.data.passed_at !== null).length;
        return {
            total,
            passed,
            percent: total > 0 ? Math.round((passed / total) * 100) : 0,
        };
    };
    return {
        kanji: tally(kanji),
        radicals: tally(radicals),
        threshold: 90,
    };
}

async function getHitRate(apiKey, days = 30) {
    // GET /reviews is deprecated; use review_statistics updated in the window instead.
    // Stats are cumulative per item, so this is an approximation of recent accuracy.
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    const stats = await fetchAllPages(
        `/review_statistics?updated_after=${encodeURIComponent(since.toISOString())}`,
        apiKey
    );
    if (stats.length === 0) return null;
    let correct = 0, total = 0;
    for (const s of stats) {
        correct += (s.data.meaning_correct || 0) + (s.data.reading_correct || 0);
        total += (s.data.meaning_correct || 0) + (s.data.reading_correct || 0)
               + (s.data.meaning_incorrect || 0) + (s.data.reading_incorrect || 0);
    }
    if (total === 0) return null;
    return {
        hitRate: correct / total,
        sampleSize: stats.length,
        windowDays: days,
    };
}

async function getLevelProgressions(apiKey) {
    return fetchAllPages('/level_progressions', apiKey);
}

async function getResetsSince(apiKey, isoDate) {
    return fetchAllPages(
        `/resets?updated_after=${encodeURIComponent(isoDate)}`,
        apiKey
    );
}

// Cumulative hours from a kanji's current available_at until it reaches Guru I (stage 5).
// Assumes the user reviews as soon as the item becomes available and always answers correctly.
const SRS_HOURS_TO_GURU = { 1: 78, 2: 70, 3: 47, 4: 0 };

async function getLevelUpETA(apiKey, level) {
    const kanji = await fetchAllPages(
        `/assignments?levels=${level}&subject_types=kanji&hidden=false`,
        apiKey
    );
    const total = kanji.length;
    if (total === 0) return null;
    const threshold = Math.ceil(total * 0.9);

    const now = Date.now();
    const etas = kanji.map(a => {
        const stage = a.data.srs_stage;
        if (stage >= 5) return 0; // already Guru+, counts toward level-up
        if (stage === 0 || !a.data.available_at) return Infinity; // in lessons or locked
        const hoursLeft = SRS_HOURS_TO_GURU[stage] ?? Infinity;
        const base = Math.max(now, new Date(a.data.available_at).getTime());
        return base + hoursLeft * 3_600_000;
    }).sort((a, b) => a - b);

    const etaMs = etas[threshold - 1];
    if (!isFinite(etaMs)) return null;
    return {
        eta: new Date(etaMs),
        passed: etas.filter(e => e === 0).length,
        total,
        threshold,
    };
}

// Uses total_count from a single request — no pagination needed.
async function getSubjectsPerLevel(apiKey, level) {
    const res = await wkFetch(`/subjects?levels=${level}&hidden=false`, apiKey);
    return res.total_count ?? 0;
}

async function getPersonalPace(apiKey) {
    const progressions = await getLevelProgressions(apiKey);
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

function clearCacheForApiKey(apiKey) {
    const prefix = `${apiKey}::`;
    for (const key of _cache.keys()) {
        if (key.startsWith(prefix)) _cache.delete(key);
    }
}

module.exports = {
    wkFetch,
    fetchAllPages,
    clearCacheForApiKey,
    getWaniKaniData,
    getSrsBreakdown,
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
};
