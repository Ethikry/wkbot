// WaniKani SRS minimum to level up: radical Lesson → Guru (4 + 8 + 23 + 47 = 82h)
// unlocks the rest of the kanji, then kanji Lesson → Guru (another 82h) crosses
// the 90%-kanji-at-Guru threshold. ~6.83 days end-to-end with perfect timing
// and 100% accuracy; nobody actually achieves this — see FASTEST_DAYS_PER_LEVEL.
const MIN_DAYS_PER_LEVEL_SRS = 6.83;
const FASTEST_DAYS_PER_LEVEL = 7.0;
const REVIEWS_PER_ITEM_TO_BURN = 8;
const DEFAULT_HIT_RATE = 0.85;

// Used only when projectPace is called without itemCounts (e.g. legacy callers,
// or when the subjects cache is empty AND the caller didn't provide a fallback).
// Reflects the ~150-items-per-level average across levels 3–60.
const FALLBACK_ITEMS_PER_LEVEL = 140;

const PACE_PRESETS = {
    fastest: {
        key: 'fastest',
        label: '🚀 Fastest',
        emoji: '🚀',
        labelText: 'Fastest',
        daysPerLevel: FASTEST_DAYS_PER_LEVEL,
    },
    comfortable: {
        key: 'comfortable',
        label: '🎯 Comfortable',
        emoji: '🎯',
        labelText: 'Comfortable',
        daysPerLevel: 10,
    },
    relaxed: {
        key: 'relaxed',
        label: '🏖️ Relaxed',
        emoji: '🏖️',
        labelText: 'Relaxed',
        daysPerLevel: 14,
    },
};

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

function daysBetween(from, to) {
    const ms = new Date(to).getTime() - new Date(from).getTime();
    return ms / (1000 * 60 * 60 * 24);
}

function resolveItemCounts(itemCounts, levelsRemaining) {
    if (itemCounts && Number.isFinite(itemCounts.total) && itemCounts.total > 0) {
        return itemCounts;
    }
    const total = Math.max(1, levelsRemaining) * FALLBACK_ITEMS_PER_LEVEL;
    return { radicals: 0, kanji: 0, vocabulary: 0, kanaVocabulary: 0, total, levels: levelsRemaining, source: 'fallback' };
}

// projectPace models two independent constraints:
//   1. Level-up cadence — how fast the user can advance levels under SRS. The
//      effective pace can't be faster than minPaceDaysPerLevel (the preset's
//      floor) and can't be faster than the WK SRS minimum. The minimum is the
//      90%-kanji-at-Guru chain; see MIN_DAYS_PER_LEVEL_SRS.
//   2. Lesson volume — total items in the level range divided by days
//      remaining. This is the actual daily learning load, not items-per-level
//      divided by days-per-level (which under-counts when there's deadline
//      buffer because lessons amortize over the whole window, not one level).
function projectPace({
    targetLevel,
    currentLevel,
    deadline,
    hitRate,
    daysPerLevel: minPaceDaysPerLevel,
    itemCounts,
}) {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const daysRemaining = Math.max(1, Math.ceil(daysBetween(todayStr, deadline)));
    const levelsRemaining = Math.max(1, targetLevel - currentLevel);
    const requiredDaysPerLevel = daysRemaining / levelsRemaining;

    const counts = resolveItemCounts(itemCounts, levelsRemaining);

    // Effective cadence: never faster than the preset floor, never slower than
    // required-to-hit-deadline (so the "projected finish" reflects the user's
    // intent of advancing at preset speed or faster if needed).
    const effectiveDaysPerLevel = Math.max(minPaceDaysPerLevel, requiredDaysPerLevel);

    const effectiveHitRate = clamp(hitRate ?? DEFAULT_HIT_RATE, 0.5, 1);

    // Lesson volume amortized over the whole project window.
    const lessonsPerDay = Math.max(1, Math.ceil(counts.total / daysRemaining));

    // Reviews scale with lessons; each item sees ~REVIEWS_PER_ITEM_TO_BURN
    // touches over its lifecycle, inflated by 1/hit_rate to cover retries.
    const reviewsPerDay = Math.max(
        lessonsPerDay,
        Math.ceil(lessonsPerDay * REVIEWS_PER_ITEM_TO_BURN / effectiveHitRate)
    );

    const projectedFinishMs = today.getTime() + Math.ceil(effectiveDaysPerLevel * levelsRemaining) * 24 * 60 * 60 * 1000;
    const projectedFinish = new Date(projectedFinishMs).toISOString().slice(0, 10);

    // Feasibility is a level-up question, not a volume question: can the user
    // physically advance enough levels under SRS minimums by the deadline?
    const underWaniKaniMinimum = requiredDaysPerLevel < MIN_DAYS_PER_LEVEL_SRS;
    const feasibleAtPace = minPaceDaysPerLevel <= requiredDaysPerLevel
        && minPaceDaysPerLevel >= MIN_DAYS_PER_LEVEL_SRS;

    return {
        daysRemaining,
        levelsRemaining,
        requiredDaysPerLevel,
        feasibleAtPace,
        underWaniKaniMinimum,
        lessonsPerDay,
        reviewsPerDay,
        projectedFinish,
        effectiveHitRate,
        daysPerLevel: effectiveDaysPerLevel,
        paceFloor: minPaceDaysPerLevel,
        itemCounts: counts,
    };
}

function paceOptionsFor(opts) {
    const presets = Object.values(PACE_PRESETS).map(p => ({
        ...p,
        projection: projectPace({ ...opts, daysPerLevel: p.daysPerLevel }),
    }));
    if (opts.personalPace?.daysPerLevel) {
        presets.push({
            key: 'personal',
            label: '📊 Personal',
            emoji: '📊',
            labelText: 'Personal',
            daysPerLevel: opts.personalPace.daysPerLevel,
            projection: projectPace({ ...opts, daysPerLevel: opts.personalPace.daysPerLevel }),
        });
    }
    return presets;
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
};
