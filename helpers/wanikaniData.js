const fetch = require('node-fetch');

const BASE = 'https://api.wanikani.com/v2';

async function wkFetch(pathOrUrl, apiKey, { timeoutMs = 10000, retries = 1 } = {}) {
    if (!apiKey) throw new Error('API key is required');
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: ctrl.signal,
            });
            clearTimeout(timer);

            if (res.status === 429) {
                if (attempt < retries) {
                    await sleep(2000 * (attempt + 1));
                    continue;
                }
                const body = await res.text().catch(() => '');
                throw new Error(`WaniKani API rate-limited: ${body.slice(0, 200)}`);
            }

            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`WaniKani API ${res.status}: ${body.slice(0, 200)}`);
            }

            return await res.json();
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
    const res = await wkFetch(`/reviews?updated_after=${encodeURIComponent(isoDate)}`, apiKey);
    return res.total_count ?? 0;
}

async function getLessonsCompletedSince(apiKey, isoDate) {
    const res = await wkFetch(`/assignments?started_after=${encodeURIComponent(isoDate)}`, apiKey);
    return res.total_count ?? 0;
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

module.exports = {
    wkFetch,
    fetchAllPages,
    getWaniKaniData,
    getSrsBreakdown,
    getReviewsCompletedSince,
    getLessonsCompletedSince,
    getBurnedCount,
    getRandomKanjiAtLevel,
};
