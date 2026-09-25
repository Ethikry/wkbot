const { addDaysToDateKey } = require('./botTime');

// WaniKani "Study Streak" semantics, reimplemented locally.
//
// Rules taken from https://knowledge.wanikani.com/widgets/study-streak/:
//   • A day counts as studied if you did *either* lessons or reviews — one is
//     as good as a thousand.
//   • Miss a day and an "offering to the Crabigator" is spent to preserve the
//     streak. You hold at most two, and a spent offering returns seven days
//     later, which works out to "you may miss up to two days in any seven-day
//     window, back-to-back or spread out".
//   • Miss a day with no offering in hand and the streak breaks.
//
// A day covered by an offering still counts toward the streak number: on the
// WK widget the turtle moves onto that day and leaves a ghost turtle behind in
// the offerings tray, so the streak keeps climbing across it.
//
// Offerings are a property of the account, not of the streak — breaking a
// streak does not hand you two fresh offerings, they still have to recharge.
const MAX_OFFERINGS = 2;
const OFFERING_COOLDOWN_DAYS = 7;

// Days we have no snapshot for are days the bot was not watching (it was down,
// or the account had not been linked yet) — not days the user skipped. We
// carry the streak across them rather than spending offerings on unobserved
// days, but only up to a point: a blackout longer than the offering cooldown
// tells us nothing about a whole week, so the streak restarts after it.
const MAX_UNOBSERVED_GAP_DAYS = 7;

function emptyResult(todayKey, offeringsUsed = []) {
    return {
        currentStreak: 0,
        lastActiveDate: null,
        lastStreakDate: null,
        frozenDates: [],
        offeringDates: [...offeringsUsed],
        offeringsAvailable: MAX_OFFERINGS - spentWithinCooldown(offeringsUsed, todayKey),
        offeringReturnDate: nextReturnDate(offeringsUsed, todayKey),
    };
}

// Offerings spent on days that have not recharged yet as of `dayKey`: one
// spent on D is gone for D..D+6 and is back on D+7.
function spentWithinCooldown(offeringsUsed, dayKey) {
    const earliest = addDaysToDateKey(dayKey, -(OFFERING_COOLDOWN_DAYS - 1));
    return offeringsUsed.filter(d => d >= earliest && d <= dayKey).length;
}

function nextReturnDate(offeringsUsed, dayKey) {
    const earliest = addDaysToDateKey(dayKey, -(OFFERING_COOLDOWN_DAYS - 1));
    const pending = offeringsUsed.filter(d => d >= earliest && d <= dayKey).sort();
    if (pending.length === 0) return null;
    return addDaysToDateKey(pending[0], OFFERING_COOLDOWN_DAYS);
}

/**
 * Replays a user's day-by-day history forward and returns the streak as
 * WaniKani would count it.
 *
 * The replay has to run forward rather than walking backward from today the
 * way the old implementation did: whether a missed day may be frozen depends
 * on how many offerings the *preceding* week already consumed, which a
 * backward walk does not know yet.
 *
 * @param {Array<{snapshot_date: string, reviews_completed: number, lessons_completed: number}>} history
 *        Snapshot rows in any order. Only dates >= `floorDate` are considered.
 * @param {string} todayKey  The user's current local date (YYYY-MM-DD).
 * @param {{floorDate?: string|null}} [options]
 *        `floorDate` drops history before a hard boundary — a WaniKani reset,
 *        where pre-reset activity must not prop the streak up.
 */
function computeReviewStreak(history, todayKey, options = {}) {
    const floorDate = options.floorDate ?? null;

    const studied = new Map();
    for (const h of history) {
        if (floorDate && h.snapshot_date < floorDate) continue;
        if (h.snapshot_date > todayKey) continue;
        const activity = (h.reviews_completed ?? 0) + (h.lessons_completed ?? 0);
        studied.set(h.snapshot_date, activity > 0);
    }

    const offeringsUsed = [];
    if (studied.size === 0) return emptyResult(todayKey, offeringsUsed);

    let streak = 0;
    let lastActiveDate = null;
    let lastStreakDate = null;
    let frozenDates = [];
    let gapRun = 0;

    const breakStreak = () => {
        streak = 0;
        lastActiveDate = null;
        lastStreakDate = null;
        frozenDates = [];
    };

    let cursor = [...studied.keys()].sort()[0];
    while (cursor <= todayKey) {
        const didStudy = studied.get(cursor);

        if (didStudy === undefined) {
            gapRun++;
            if (gapRun > MAX_UNOBSERVED_GAP_DAYS) breakStreak();
        } else {
            gapRun = 0;
            if (didStudy) {
                streak++;
                lastActiveDate = cursor;
                lastStreakDate = cursor;
            } else if (cursor === todayKey) {
                // Today is still in progress — nothing has been missed yet.
            } else if (streak > 0) {
                const available = MAX_OFFERINGS - spentWithinCooldown(offeringsUsed, cursor);
                if (available > 0) {
                    offeringsUsed.push(cursor);
                    frozenDates.push(cursor);
                    streak++;
                    lastStreakDate = cursor;
                } else {
                    breakStreak();
                }
            }
        }

        cursor = addDaysToDateKey(cursor, 1);
    }

    return {
        currentStreak: streak,
        lastActiveDate,
        lastStreakDate,
        frozenDates,
        // Every day an offering was spent on, including ones inside streaks
        // that have since broken — `frozenDates` only covers the live streak.
        offeringDates: offeringsUsed,
        offeringsAvailable: MAX_OFFERINGS - spentWithinCooldown(offeringsUsed, todayKey),
        offeringReturnDate: nextReturnDate(offeringsUsed, todayKey),
    };
}

module.exports = {
    MAX_OFFERINGS,
    OFFERING_COOLDOWN_DAYS,
    MAX_UNOBSERVED_GAP_DAYS,
    computeReviewStreak,
};
