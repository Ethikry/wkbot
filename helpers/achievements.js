const db = require('../db');

// Evaluate every achievement definition against the user's current state and
// upsert any newly-eligible rows into user_achievements. Returns the keys that
// were newly unlocked this evaluation (caller may want to announce them).
async function evaluateAchievements({ discordUserId, wanikaniUserId }) {
    const acct = await db.get(
        `SELECT level FROM wanikani_accounts WHERE wanikani_user_id = ?`,
        [wanikaniUserId]
    );
    const burnedRow = await db.get(
        `SELECT COUNT(*) AS n FROM wk_assignments
         WHERE wanikani_user_id = ? AND srs_stage = 9 AND hidden = 0`,
        [wanikaniUserId]
    );
    const streakRow = await db.get(
        `SELECT MAX(longest_streak) AS longest, MAX(current_streak) AS current
         FROM streaks WHERE discord_user_id = ?`,
        [discordUserId]
    );
    const reviewsRow = await db.get(
        `SELECT COALESCE(SUM(reviews_completed), 0) AS n
         FROM daily_snapshots WHERE discord_user_id = ?`,
        [discordUserId]
    );

    const level = acct?.level ?? 0;
    const burned = burnedRow?.n ?? 0;
    const longestStreak = streakRow?.longest ?? 0;
    const totalReviews = reviewsRow?.n ?? 0;

    const checks = [
        ['first_burn',   burned >= 1],
        ['100_burns',    burned >= 100],
        ['500_burns',    burned >= 500],
        ['1000_burns',   burned >= 1000],
        ['level_10',     level >= 10],
        ['level_30',     level >= 30],
        ['level_60',     level >= 60],
        ['streak_7',     longestStreak >= 7],
        ['streak_30',    longestStreak >= 30],
        ['streak_100',   longestStreak >= 100],
        ['500_reviews',  totalReviews >= 500],
        ['5000_reviews', totalReviews >= 5000],
    ];

    const newlyUnlocked = [];
    for (const [key, eligible] of checks) {
        if (!eligible) continue;
        const result = await db.run(
            `INSERT OR IGNORE INTO user_achievements
                (achievement_key, discord_user_id, wanikani_user_id, guild_id)
             VALUES (?, ?, ?, 'GLOBAL')`,
            [key, discordUserId, wanikaniUserId]
        );
        if (result.changes > 0) newlyUnlocked.push(key);
    }
    return newlyUnlocked;
}

module.exports = { evaluateAchievements };
