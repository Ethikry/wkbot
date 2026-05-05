const db = require('../db');

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const PRUNE_OLDER_THAN_HOURS = 48;
const KEPT_UP_LOWER_BOUND_HOURS = 25;
const KEPT_UP_UPPER_BOUND_HOURS = 23;

async function recordPoll(userId, guildId, dueRightNow) {
    const now = new Date().toISOString();

    await db.run(
        `INSERT OR IGNORE INTO queue_history (user_id, guild_id, recorded_at, queue_size)
         VALUES (?, ?, ?, ?)`,
        [userId, guildId, now, dueRightNow]
    );

    if (dueRightNow === 0) {
        await db.run(
            `INSERT INTO user_state (user_id, guild_id, last_zero_due_at) VALUES (?, ?, ?)
             ON CONFLICT(user_id, guild_id) DO UPDATE SET last_zero_due_at = excluded.last_zero_due_at`,
            [userId, guildId, now]
        );
    }

    const cutoff = new Date(Date.now() - PRUNE_OLDER_THAN_HOURS * 60 * 60 * 1000).toISOString();
    await db.run(
        `DELETE FROM queue_history WHERE user_id = ? AND guild_id = ? AND recorded_at < ?`,
        [userId, guildId, cutoff]
    );
}

async function lastZeroWithin24h(userId, guildId) {
    const state = await db.get(
        `SELECT last_zero_due_at FROM user_state WHERE user_id = ? AND guild_id = ?`,
        [userId, guildId]
    );
    if (!state?.last_zero_due_at) return false;
    const ageMs = Date.now() - new Date(state.last_zero_due_at).getTime();
    return ageMs >= 0 && ageMs <= TWENTY_FOUR_HOURS_MS;
}

async function getQueueComparison(userId, guildId) {
    const recent = await db.get(
        `SELECT queue_size, recorded_at FROM queue_history
         WHERE user_id = ? AND guild_id = ?
         ORDER BY recorded_at DESC LIMIT 1`,
        [userId, guildId]
    );
    if (!recent) return null;

    const upper = new Date(Date.now() - KEPT_UP_UPPER_BOUND_HOURS * 60 * 60 * 1000).toISOString();
    const lower = new Date(Date.now() - KEPT_UP_LOWER_BOUND_HOURS * 60 * 60 * 1000).toISOString();
    const old = await db.get(
        `SELECT queue_size FROM queue_history
         WHERE user_id = ? AND guild_id = ? AND recorded_at BETWEEN ? AND ?
         ORDER BY recorded_at ASC LIMIT 1`,
        [userId, guildId, lower, upper]
    );
    if (!old) return null;

    return {
        currentQueue: recent.queue_size,
        oldQueue: old.queue_size,
        keptUp: recent.queue_size <= old.queue_size,
    };
}

async function evaluateAllGoal(userId, guildId, reviewsCompleted) {
    const reviewsOk = reviewsCompleted > 0;
    if (!reviewsOk) return { ok: false, reason: 'no_reviews' };

    if (await lastZeroWithin24h(userId, guildId)) {
        return { ok: true, reason: 'cleared' };
    }

    const comparison = await getQueueComparison(userId, guildId);
    if (comparison?.keptUp) {
        return { ok: true, reason: 'kept_up' };
    }

    return { ok: false, reason: comparison ? 'queue_grew' : 'insufficient_history' };
}

module.exports = {
    recordPoll,
    lastZeroWithin24h,
    getQueueComparison,
    evaluateAllGoal,
};
