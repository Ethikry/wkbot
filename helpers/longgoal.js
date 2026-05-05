const ITEMS_PER_LEVEL = 90;
const MIN_DAYS_PER_LEVEL = 6.83;
const REVIEWS_PER_ITEM_TO_BURN = 8;
const DEFAULT_HIT_RATE = 0.85;

const PACE_PRESETS = {
    fastest: {
        key: 'fastest',
        label: '🚀 Fastest',
        emoji: '🚀',
        labelText: 'Fastest',
        daysPerLevel: 7,
        summary: 'Close to WaniKani\'s theoretical maximum. Demands consistency every day.',
    },
    comfortable: {
        key: 'comfortable',
        label: '🎯 Comfortable',
        emoji: '🎯',
        labelText: 'Comfortable',
        daysPerLevel: 10,
        summary: 'Sustainable for most learners. Realistic if you study daily.',
    },
    relaxed: {
        key: 'relaxed',
        label: '🏖️ Relaxed',
        emoji: '🏖️',
        labelText: 'Relaxed',
        daysPerLevel: 14,
        summary: 'Forgiving cadence. Good for busy schedules.',
    },
};

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

function daysBetween(from, to) {
    const ms = new Date(to).getTime() - new Date(from).getTime();
    return ms / (1000 * 60 * 60 * 24);
}

function projectPace({ targetLevel, currentLevel, deadline, hitRate, daysPerLevel }) {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const daysRemaining = Math.max(1, Math.ceil(daysBetween(todayStr, deadline)));
    const levelsRemaining = Math.max(1, targetLevel - currentLevel);
    const requiredDaysPerLevel = daysRemaining / levelsRemaining;
    const effectiveHitRate = clamp(hitRate ?? DEFAULT_HIT_RATE, 0.5, 1);
    const lessonsPerDay = Math.max(1, Math.ceil(ITEMS_PER_LEVEL / daysPerLevel));
    const reviewsPerDay = Math.max(
        lessonsPerDay,
        Math.ceil(lessonsPerDay * REVIEWS_PER_ITEM_TO_BURN / effectiveHitRate)
    );
    const projectedFinishMs = today.getTime() + Math.ceil(daysPerLevel * levelsRemaining) * 24 * 60 * 60 * 1000;
    const projectedFinish = new Date(projectedFinishMs).toISOString().slice(0, 10);
    return {
        daysRemaining,
        levelsRemaining,
        requiredDaysPerLevel,
        feasibleAtPace: daysPerLevel <= requiredDaysPerLevel,
        underWaniKaniMinimum: daysPerLevel < MIN_DAYS_PER_LEVEL,
        lessonsPerDay,
        reviewsPerDay,
        projectedFinish,
        effectiveHitRate,
        daysPerLevel,
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
            summary: `Your historic average of ~${opts.personalPace.daysPerLevel.toFixed(1)} days/level (last ${opts.personalPace.sampleSize}).`,
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
    ITEMS_PER_LEVEL,
    MIN_DAYS_PER_LEVEL,
    REVIEWS_PER_ITEM_TO_BURN,
    DEFAULT_HIT_RATE,
    projectPace,
    paceOptionsFor,
    isValidDeadline,
    isValidLevel,
    daysBetween,
};
