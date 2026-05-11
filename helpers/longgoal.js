// WaniKani SRS minimum to level up: radical Lesson -> Guru (4 + 8 + 23 + 47 = 82h)
// unlocks the rest of the kanji, then kanji Lesson -> Guru (another 82h) crosses
// the 90%-kanji-at-Guru threshold. ~6.83 days end-to-end with perfect timing
// and 100% accuracy. We inflate this by the user's recent hit rate when
// projecting long-term goals.
const MIN_DAYS_PER_LEVEL_SRS = 6.83;
const FASTEST_DAYS_PER_LEVEL = MIN_DAYS_PER_LEVEL_SRS;
const REVIEWS_PER_ITEM_TO_BURN = 8;
const DEFAULT_HIT_RATE = 0.85;

// Used only when projectPace is called without itemCounts (e.g. legacy callers,
// or when the subjects cache is empty AND the caller didn't provide a fallback).
// Reflects the ~150-items-per-level average across levels 3–60.
const FALLBACK_ITEMS_PER_LEVEL = 140;

const PACE_PRESETS = {
    goal: {
        key: 'goal',
        label: '🎯 Goal Rate',
        emoji: '🎯',
        labelText: 'Goal Rate',
    },
    fastest: {
        key: 'fastest',
        label: '🚀 Fastest SRS',
        emoji: '🚀',
        labelText: 'Fastest',
    },
    ten: {
        key: 'ten',
        label: '📚 10/day',
        emoji: '📚',
        labelText: '10/day',
        dailyLessons: 10,
    },
    five: {
        key: 'five',
        label: '🌱 5/day',
        emoji: '🌱',
        labelText: '5/day',
        dailyLessons: 5,
    },
};

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

function daysBetween(from, to) {
    const ms = new Date(to).getTime() - new Date(from).getTime();
    return ms / (1000 * 60 * 60 * 24);
}

function datePlusDays(from, days) {
    const d = new Date(from);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}

function isoDate(d) {
    return d.toISOString().slice(0, 10);
}

function resolveItemCounts(itemCounts, levelsRemaining) {
    if (itemCounts && Number.isFinite(itemCounts.total) && itemCounts.total >= 0) {
        return itemCounts;
    }
    const total = Math.max(1, levelsRemaining) * FALLBACK_ITEMS_PER_LEVEL;
    return { radicals: 0, kanji: 0, vocabulary: 0, kanaVocabulary: 0, total, levels: levelsRemaining, source: 'fallback' };
}

function normalizeHitRate(hitRate) {
    return clamp(Number.isFinite(hitRate) ? hitRate : DEFAULT_HIT_RATE, 0.01, 1);
}

function estimateReviewsPerDay(lessonsPerDay, hitRate) {
    if (!lessonsPerDay) return 0;
    return Math.max(
        lessonsPerDay,
        Math.ceil((lessonsPerDay * REVIEWS_PER_ITEM_TO_BURN) / normalizeHitRate(hitRate))
    );
}

// projectPace models two constraints:
//   1. Lesson volume: every not-yet-started item through the target level must
//      fit into the selected daily lesson rate.
//   2. Level-up cadence: even infinite lessons cannot beat WaniKani's SRS
//      timing. The SRS floor is inflated by recent hit rate, assuming the user
//      clears reviews every day and misses cause retries.
function projectPace({
    targetLevel,
    currentLevel,
    deadline,
    hitRate,
    itemCounts,
    dailyLessons,
}) {
    const today = new Date();
    const todayStr = isoDate(today);
    const daysRemaining = Math.max(1, Math.ceil(daysBetween(todayStr, deadline)));
    const levelsRemaining = Math.max(1, targetLevel - currentLevel);

    const counts = resolveItemCounts(itemCounts, levelsRemaining);
    const totalLessons = Math.max(0, counts.total ?? 0);
    const effectiveHitRate = normalizeHitRate(hitRate);

    const minimumDaysPerLevel = MIN_DAYS_PER_LEVEL_SRS / effectiveHitRate;
    const minimumSrsDays = Math.ceil(minimumDaysPerLevel * levelsRemaining);
    const requiredLessonsPerDay = totalLessons === 0 ? 0 : Math.ceil(totalLessons / daysRemaining);
    const fastestLessonsPerDay = totalLessons === 0
        ? 0
        : Math.max(1, Math.ceil(totalLessons / Math.max(1, minimumSrsDays)));

    const requestedLessons = dailyLessons ?? requiredLessonsPerDay;
    const lessonsPerDay = totalLessons === 0 ? 0 : Math.max(1, Math.ceil(requestedLessons));
    const lessonDays = totalLessons === 0 ? 0 : Math.ceil(totalLessons / lessonsPerDay);
    const projectedDays = Math.max(lessonDays, minimumSrsDays);
    const projectedFinish = isoDate(datePlusDays(today, projectedDays));
    const reviewsPerDay = estimateReviewsPerDay(lessonsPerDay, effectiveHitRate);

    const underWaniKaniMinimum = minimumSrsDays > daysRemaining;
    const feasibleAtPace = projectedDays <= daysRemaining;

    return {
        daysRemaining,
        levelsRemaining,
        requiredDaysPerLevel: daysRemaining / levelsRemaining,
        feasibleAtPace,
        underWaniKaniMinimum,
        lessonsPerDay,
        reviewsPerDay,
        projectedFinish,
        projectedDays,
        lessonDays,
        minimumSrsDays,
        minimumDaysPerLevel,
        effectiveHitRate,
        daysPerLevel: projectedDays / levelsRemaining,
        requiredLessonsPerDay,
        fastestLessonsPerDay,
        totalLessons,
        itemCounts: counts,
    };
}

function paceOptionsFor(opts) {
    const baseline = projectPace(opts);
    const specs = [
        { ...PACE_PRESETS.goal, dailyLessons: baseline.requiredLessonsPerDay },
        { ...PACE_PRESETS.fastest, dailyLessons: baseline.fastestLessonsPerDay },
        PACE_PRESETS.ten,
        PACE_PRESETS.five,
    ];
    return specs.map(p => ({
        ...p,
        projection: projectPace({ ...opts, dailyLessons: p.dailyLessons }),
    }));
}

function isValidDeadline(deadlineStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadlineStr)) return false;
    const d = new Date(deadlineStr + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return false;
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return d >= tomorrow;
}

function isValidLevel(n) {
    return Number.isInteger(n) && n >= 2 && n <= 60;
}

module.exports = {
    PACE_PRESETS,
    MIN_DAYS_PER_LEVEL_SRS,
    FASTEST_DAYS_PER_LEVEL,
    FALLBACK_ITEMS_PER_LEVEL,
    REVIEWS_PER_ITEM_TO_BURN,
    DEFAULT_HIT_RATE,
    projectPace,
    paceOptionsFor,
    isValidDeadline,
    isValidLevel,
    daysBetween,
    estimateReviewsPerDay,
    normalizeHitRate,
};
