async function runMigrations({ get, all, run }) {
    // The original `users` table had a malformed schema (stray comma). It was never used.
    await run(`DROP TABLE IF EXISTS users`);

    await run(`CREATE TABLE IF NOT EXISTS apikeys (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        api_key TEXT,
        ping_enabled INTEGER DEFAULT 1,
        PRIMARY KEY (user_id, guild_id)
    )`);

    const apikeyCols = await all(`PRAGMA table_info(apikeys)`);
    if (!apikeyCols.find(c => c.name === 'ping_enabled')) {
        await run(`ALTER TABLE apikeys ADD COLUMN ping_enabled INTEGER DEFAULT 1`);
    }

    await run(`CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT,
        daily_time TEXT NOT NULL DEFAULT '15:00',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        morning_ping_enabled INTEGER NOT NULL DEFAULT 0,
        morning_time TEXT NOT NULL DEFAULT '08:00',
        shame_mode_enabled INTEGER NOT NULL DEFAULT 0,
        shame_time TEXT NOT NULL DEFAULT '22:00',
        weekly_leaderboard_enabled INTEGER NOT NULL DEFAULT 1,
        weekly_leaderboard_day INTEGER NOT NULL DEFAULT 0,
        weekly_leaderboard_time TEXT NOT NULL DEFAULT '20:00',
        mod_role_id TEXT,
        level_up_announcements INTEGER NOT NULL DEFAULT 1,
        burn_celebrations INTEGER NOT NULL DEFAULT 1
    )`);

    await run(`CREATE TABLE IF NOT EXISTS streaks (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        current_streak INTEGER NOT NULL DEFAULT 0,
        longest_streak INTEGER NOT NULL DEFAULT 0,
        last_review_date TEXT,
        PRIMARY KEY (user_id, guild_id)
    )`);

    await run(`CREATE TABLE IF NOT EXISTS daily_snapshots (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        date TEXT NOT NULL,
        reviews_completed INTEGER NOT NULL DEFAULT 0,
        lessons_completed INTEGER NOT NULL DEFAULT 0,
        level INTEGER,
        burned INTEGER,
        PRIMARY KEY (user_id, guild_id, date)
    )`);

    await run(`CREATE TABLE IF NOT EXISTS goals (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        daily_lessons INTEGER NOT NULL DEFAULT 0,
        daily_reviews INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, guild_id)
    )`);

    await run(`CREATE TABLE IF NOT EXISTS user_state (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        last_known_level INTEGER,
        last_known_burned INTEGER,
        last_zero_due_at TEXT,
        PRIMARY KEY (user_id, guild_id)
    )`);

    const goalCols = await all(`PRAGMA table_info(goals)`);
    if (!goalCols.find(c => c.name === 'daily_all')) {
        await run(`ALTER TABLE goals ADD COLUMN daily_all INTEGER NOT NULL DEFAULT 0`);
    }

    const stateCols = await all(`PRAGMA table_info(user_state)`);
    if (!stateCols.find(c => c.name === 'last_zero_due_at')) {
        await run(`ALTER TABLE user_state ADD COLUMN last_zero_due_at TEXT`);
    }

    await run(`CREATE TABLE IF NOT EXISTS queue_history (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        queue_size INTEGER NOT NULL,
        PRIMARY KEY (user_id, guild_id, recorded_at)
    )`);

    await run(`CREATE INDEX IF NOT EXISTS idx_queue_history_lookup
        ON queue_history(user_id, guild_id, recorded_at)`);

    await run(`CREATE TABLE IF NOT EXISTS long_goals (
        user_id TEXT PRIMARY KEY,
        target_level INTEGER NOT NULL,
        deadline TEXT NOT NULL,
        pace_mode TEXT,
        days_per_level REAL NOT NULL,
        items_per_level INTEGER NOT NULL,
        daily_lessons INTEGER NOT NULL,
        daily_reviews INTEGER NOT NULL,
        hit_rate REAL,
        notify_pace_daily INTEGER NOT NULL DEFAULT 0,
        notify_reviews_available INTEGER NOT NULL DEFAULT 0,
        notify_review_threshold INTEGER NOT NULL DEFAULT 50,
        last_pace_alert_at TEXT,
        last_review_alert_at TEXT,
        created_at TEXT NOT NULL
    )`);
}

module.exports = { runMigrations };
