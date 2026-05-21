const db = require('../db');

const MIN_MEMBERS_FOR_ALL = 3;

// Evaluate guild-aggregate achievements for one guild and upsert any newly
// eligible rows into guild_achievements. Returns the keys newly unlocked this
// run (callers may want to announce them to the guild channel).
async function evaluateGuildAchievements(guildId) {
    const reviewsRow = await db.get(
        `SELECT COALESCE(SUM(ds.reviews_completed), 0) AS n
         FROM daily_snapshots ds
         WHERE ds.guild_id = ?`,
        [guildId]
    );
    const burnedRow = await db.get(
        `SELECT COALESCE(COUNT(*), 0) AS n
         FROM wk_assignments a
         JOIN wanikani_accounts wa ON wa.wanikani_user_id = a.wanikani_user_id
         JOIN guild_members gm ON gm.discord_user_id = wa.discord_user_id
         WHERE gm.guild_id = ? AND a.srs_stage = 9 AND a.hidden = 0`,
        [guildId]
    );
    const levelRow = await db.get(
        `SELECT COUNT(*) AS members, MIN(wa.level) AS min_level
         FROM guild_members gm
         JOIN wanikani_accounts wa ON wa.discord_user_id = gm.discord_user_id
         WHERE gm.guild_id = ?`,
        [guildId]
    );
    const streakRow = await db.get(
        `SELECT COALESCE(SUM(current_streak), 0) AS n
         FROM streaks WHERE guild_id = ?`,
        [guildId]
    );

    const totalReviews = reviewsRow?.n ?? 0;
    const totalBurned = burnedRow?.n ?? 0;
    const memberCount = levelRow?.members ?? 0;
    const minLevel = levelRow?.min_level ?? 0;
    const streakSum = streakRow?.n ?? 0;
    const allAtLeast = (n) => memberCount >= MIN_MEMBERS_FOR_ALL && minLevel >= n;

    const checks = [
        ['guild_10k_reviews',      totalReviews >= 10_000,  totalReviews],
        ['guild_100k_reviews',     totalReviews >= 100_000, totalReviews],
        ['guild_1k_burns',         totalBurned  >= 1_000,   totalBurned],
        ['guild_10k_burns',        totalBurned  >= 10_000,  totalBurned],
        ['guild_all_level_10',     allAtLeast(10),          minLevel],
        ['guild_all_level_30',     allAtLeast(30),          minLevel],
        ['guild_streak_total_100', streakSum    >= 100,     streakSum],
    ];

    const newlyUnlocked = [];
    for (const [key, eligible, value] of checks) {
        if (!eligible) continue;
        const result = await db.run(
            `INSERT OR IGNORE INTO guild_achievements (guild_id, achievement_key, metric_value)
             VALUES (?, ?, ?)`,
            [guildId, key, value]
        );
        if (result.changes > 0) newlyUnlocked.push(key);
    }
    return newlyUnlocked;
}

module.exports = { evaluateGuildAchievements };
