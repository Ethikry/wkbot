const SCHEMA_V1 = [
    // ── identity / guild config ────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS discord_users (
        discord_user_id TEXT PRIMARY KEY,
        display_name TEXT,
        global_name TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        announcement_channel_id TEXT,
        reminder_channel_id TEXT,
        leaderboard_channel_id TEXT,
        timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
        daily_summary_enabled INTEGER NOT NULL DEFAULT 1,
        daily_summary_time TEXT NOT NULL DEFAULT '00:00',
        morning_ping_enabled INTEGER NOT NULL DEFAULT 0,
        morning_ping_time TEXT NOT NULL DEFAULT '08:00',
        shame_mode_enabled INTEGER NOT NULL DEFAULT 0,
        shame_time TEXT NOT NULL DEFAULT '22:00',
        weekly_leaderboard_enabled INTEGER NOT NULL DEFAULT 1,
        weekly_leaderboard_day INTEGER NOT NULL DEFAULT 0,
        weekly_leaderboard_time TEXT NOT NULL DEFAULT '20:00',
        level_up_announcements_enabled INTEGER NOT NULL DEFAULT 1,
        burn_celebrations_enabled INTEGER NOT NULL DEFAULT 1,
        reviews_cleared_announcements_enabled INTEGER NOT NULL DEFAULT 1,
        mod_role_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS guild_members (
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        nickname TEXT,
        leaderboard_opt_out INTEGER NOT NULL DEFAULT 0,
        reminders_opt_out INTEGER NOT NULL DEFAULT 0,
        joined_bot_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, discord_user_id),
        FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
        FOREIGN KEY (discord_user_id) REFERENCES discord_users(discord_user_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS wanikani_accounts (
        wanikani_user_id TEXT PRIMARY KEY,
        discord_user_id TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        profile_url TEXT,
        level INTEGER NOT NULL,
        started_at TEXT,
        current_vacation_started_at TEXT,
        subscription_active INTEGER,
        subscription_type TEXT,
        max_level_granted INTEGER,
        subscription_period_ends_at TEXT,
        api_token_encrypted TEXT NOT NULL,
        api_token_hint TEXT,
        api_revision TEXT NOT NULL DEFAULT '20170710',
        last_user_sync_at TEXT,
        last_full_sync_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (discord_user_id) REFERENCES discord_users(discord_user_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS wk_sync_state (
        wanikani_user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        last_synced_at TEXT,
        last_data_updated_at TEXT,
        etag TEXT,
        last_modified TEXT,
        last_status_code INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (wanikani_user_id, endpoint),
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS wk_global_sync_state (
        endpoint TEXT PRIMARY KEY,
        last_synced_at TEXT,
        last_data_updated_at TEXT,
        etag TEXT,
        last_modified TEXT,
        last_status_code INTEGER,
        last_error TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    // ── WaniKani API cache ────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wk_subjects (
        subject_id INTEGER PRIMARY KEY,
        object TEXT NOT NULL,
        url TEXT,
        data_updated_at TEXT,
        subject_type TEXT NOT NULL,
        level INTEGER,
        slug TEXT,
        characters TEXT,
        document_url TEXT,
        meaning_mnemonic TEXT,
        reading_mnemonic TEXT,
        lesson_position INTEGER,
        spaced_repetition_system_id INTEGER,
        hidden_at TEXT,
        raw_json TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wk_subjects_type_level ON wk_subjects(subject_type, level)`,
    `CREATE INDEX IF NOT EXISTS idx_wk_subjects_slug ON wk_subjects(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_wk_subjects_characters ON wk_subjects(characters)`,
    `CREATE INDEX IF NOT EXISTS idx_wk_subjects_srs ON wk_subjects(spaced_repetition_system_id)`,

    `CREATE TABLE IF NOT EXISTS wk_spaced_repetition_systems (
        srs_id INTEGER PRIMARY KEY,
        object TEXT NOT NULL,
        url TEXT,
        data_updated_at TEXT,
        name TEXT NOT NULL,
        description TEXT,
        unlocking_stage_position INTEGER,
        starting_stage_position INTEGER,
        passing_stage_position INTEGER,
        burning_stage_position INTEGER,
        raw_json TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS wk_srs_stages (
        srs_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        interval INTEGER,
        interval_unit TEXT,
        PRIMARY KEY (srs_id, position),
        FOREIGN KEY (srs_id) REFERENCES wk_spaced_repetition_systems(srs_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS wk_assignments (
        assignment_id INTEGER PRIMARY KEY,
        wanikani_user_id TEXT NOT NULL,
        object TEXT NOT NULL,
        url TEXT,
        data_updated_at TEXT,
        subject_id INTEGER NOT NULL,
        subject_type TEXT NOT NULL,
        level INTEGER,
        srs_stage INTEGER NOT NULL,
        unlocked_at TEXT,
        started_at TEXT,
        passed_at TEXT,
        burned_at TEXT,
        available_at TEXT,
        resurrected_at TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE,
        FOREIGN KEY (subject_id) REFERENCES wk_subjects(subject_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wk_assignments_user_available ON wk_assignments(wanikani_user_id, available_at)`,
    `CREATE INDEX IF NOT EXISTS idx_wk_assignments_user_srs ON wk_assignments(wanikani_user_id, srs_stage)`,
    `CREATE INDEX IF NOT EXISTS idx_wk_assignments_user_subject ON wk_assignments(wanikani_user_id, subject_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wk_assignments_user_level_type ON wk_assignments(wanikani_user_id, level, subject_type)`,
    `CREATE INDEX IF NOT EXISTS idx_wk_assignments_updated ON wk_assignments(wanikani_user_id, data_updated_at)`,

    `CREATE TABLE IF NOT EXISTS wk_review_statistics (
        review_statistic_id INTEGER PRIMARY KEY,
        wanikani_user_id TEXT NOT NULL,
        object TEXT NOT NULL,
        url TEXT,
        data_updated_at TEXT,
        subject_id INTEGER NOT NULL,
        subject_type TEXT NOT NULL,
        meaning_correct INTEGER NOT NULL DEFAULT 0,
        meaning_incorrect INTEGER NOT NULL DEFAULT 0,
        meaning_max_streak INTEGER NOT NULL DEFAULT 0,
        meaning_current_streak INTEGER NOT NULL DEFAULT 0,
        reading_correct INTEGER NOT NULL DEFAULT 0,
        reading_incorrect INTEGER NOT NULL DEFAULT 0,
        reading_max_streak INTEGER NOT NULL DEFAULT 0,
        reading_current_streak INTEGER NOT NULL DEFAULT 0,
        percentage_correct INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE,
        FOREIGN KEY (subject_id) REFERENCES wk_subjects(subject_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wk_review_stats_user_subject ON wk_review_statistics(wanikani_user_id, subject_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wk_review_stats_user_percentage ON wk_review_statistics(wanikani_user_id, percentage_correct)`,
    `CREATE INDEX IF NOT EXISTS idx_wk_review_stats_updated ON wk_review_statistics(wanikani_user_id, data_updated_at)`,

    `CREATE TABLE IF NOT EXISTS wk_study_materials (
        study_material_id INTEGER PRIMARY KEY,
        wanikani_user_id TEXT NOT NULL,
        object TEXT NOT NULL,
        url TEXT,
        data_updated_at TEXT,
        subject_id INTEGER NOT NULL,
        subject_type TEXT NOT NULL,
        meaning_note TEXT,
        reading_note TEXT,
        meaning_synonyms_json TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE,
        FOREIGN KEY (subject_id) REFERENCES wk_subjects(subject_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wk_study_materials_user_subject ON wk_study_materials(wanikani_user_id, subject_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wk_study_materials_updated ON wk_study_materials(wanikani_user_id, data_updated_at)`,

    `CREATE TABLE IF NOT EXISTS wk_level_progressions (
        level_progression_id INTEGER PRIMARY KEY,
        wanikani_user_id TEXT NOT NULL,
        object TEXT NOT NULL,
        url TEXT,
        data_updated_at TEXT,
        level INTEGER NOT NULL,
        unlocked_at TEXT,
        started_at TEXT,
        passed_at TEXT,
        completed_at TEXT,
        abandoned_at TEXT,
        raw_json TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wk_level_progressions_user_level ON wk_level_progressions(wanikani_user_id, level)`,
    `CREATE INDEX IF NOT EXISTS idx_wk_level_progressions_updated ON wk_level_progressions(wanikani_user_id, data_updated_at)`,

    `CREATE TABLE IF NOT EXISTS wk_summary_cache (
        wanikani_user_id TEXT PRIMARY KEY,
        data_updated_at TEXT,
        next_reviews_at TEXT,
        lesson_count INTEGER NOT NULL DEFAULT 0,
        review_count_now INTEGER NOT NULL DEFAULT 0,
        review_count_24h INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS wk_summary_buckets (
        wanikani_user_id TEXT NOT NULL,
        bucket_type TEXT NOT NULL CHECK (bucket_type IN ('lesson', 'review')),
        available_at TEXT NOT NULL,
        subject_ids_json TEXT NOT NULL,
        subject_count INTEGER NOT NULL,
        PRIMARY KEY (wanikani_user_id, bucket_type, available_at),
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,

    // ── engagement / reminders ────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS reminder_settings (
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        reviews_ping_enabled INTEGER NOT NULL DEFAULT 1,
        reviews_dm_enabled INTEGER NOT NULL DEFAULT 1,
        burn_announcement_enabled INTEGER NOT NULL DEFAULT 1,
        levelup_announcement_enabled INTEGER NOT NULL DEFAULT 1,
        shame_enabled INTEGER NOT NULL DEFAULT 0,
        cleared_enabled INTEGER NOT NULL DEFAULT 1,
        streak_reminder_enabled INTEGER NOT NULL DEFAULT 1,
        min_review_count INTEGER NOT NULL DEFAULT 1,
        dm_enabled INTEGER NOT NULL DEFAULT 1,
        channel_enabled INTEGER NOT NULL DEFAULT 0,
        quiet_hours_start TEXT,
        quiet_hours_end TEXT,
        timezone TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, discord_user_id),
        FOREIGN KEY (guild_id, discord_user_id) REFERENCES guild_members(guild_id, discord_user_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS user_reminder_settings (
        discord_user_id TEXT PRIMARY KEY,
        reviews_dm_enabled INTEGER NOT NULL DEFAULT 1,
        streak_reminder_enabled INTEGER NOT NULL DEFAULT 1,
        shame_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (discord_user_id) REFERENCES discord_users(discord_user_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS reminder_events (
        reminder_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        wanikani_user_id TEXT NOT NULL,
        reminder_type TEXT NOT NULL CHECK (reminder_type IN ('reviews_available', 'lessons_available', 'reviews_cleared', 'daily_summary', 'shame', 'streak_risk')),
        review_count INTEGER,
        lesson_count INTEGER,
        scheduled_for TEXT,
        sent_at TEXT,
        delivery_target TEXT NOT NULL CHECK (delivery_target IN ('dm', 'channel')),
        discord_channel_id TEXT,
        discord_message_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id, discord_user_id) REFERENCES guild_members(guild_id, discord_user_id) ON DELETE CASCADE,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reminder_events_pending ON reminder_events(status, scheduled_for)`,
    `CREATE INDEX IF NOT EXISTS idx_reminder_events_user_sent ON reminder_events(discord_user_id, sent_at)`,

    `CREATE TABLE IF NOT EXISTS goals (
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        daily_lessons INTEGER NOT NULL DEFAULT 0,
        daily_reviews INTEGER NOT NULL DEFAULT 0,
        daily_all_lessons INTEGER NOT NULL DEFAULT 0,
        daily_all_reviews INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, discord_user_id),
        FOREIGN KEY (guild_id, discord_user_id) REFERENCES guild_members(guild_id, discord_user_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS long_goals (
        discord_user_id TEXT PRIMARY KEY,
        wanikani_user_id TEXT NOT NULL,
        target_level INTEGER NOT NULL,
        deadline TEXT,
        pace_mode TEXT NOT NULL DEFAULT 'deadline',
        days_per_level REAL,
        items_per_level INTEGER,
        daily_lessons INTEGER,
        daily_reviews INTEGER,
        hit_rate REAL,
        notify_enabled INTEGER NOT NULL DEFAULT 1,
        alert_before_days INTEGER,
        last_alerted_at TEXT,
        last_projection_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (discord_user_id) REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS streaks (
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        current_streak INTEGER NOT NULL DEFAULT 0,
        longest_streak INTEGER NOT NULL DEFAULT 0,
        last_review_date TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, discord_user_id),
        FOREIGN KEY (guild_id, discord_user_id) REFERENCES guild_members(guild_id, discord_user_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS bot_user_state (
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        wanikani_user_id TEXT NOT NULL,
        last_zero_due_at TEXT,
        last_reset_checked_at TEXT,
        last_reviews_cleared_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, discord_user_id),
        FOREIGN KEY (guild_id, discord_user_id) REFERENCES guild_members(guild_id, discord_user_id) ON DELETE CASCADE,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,

    // ── historical / leaderboards / achievements ──────────────────────────
    `CREATE TABLE IF NOT EXISTS daily_snapshots (
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        wanikani_user_id TEXT NOT NULL,
        snapshot_date TEXT NOT NULL,
        level INTEGER NOT NULL,
        lessons_available INTEGER NOT NULL DEFAULT 0,
        reviews_available INTEGER NOT NULL DEFAULT 0,
        reviews_24h INTEGER NOT NULL DEFAULT 0,
        reviews_completed INTEGER NOT NULL DEFAULT 0,
        lessons_completed INTEGER NOT NULL DEFAULT 0,
        apprentice_count INTEGER NOT NULL DEFAULT 0,
        guru_count INTEGER NOT NULL DEFAULT 0,
        master_count INTEGER NOT NULL DEFAULT 0,
        enlightened_count INTEGER NOT NULL DEFAULT 0,
        burned_count INTEGER NOT NULL DEFAULT 0,
        total_assignments INTEGER NOT NULL DEFAULT 0,
        total_subjects_started INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, discord_user_id, snapshot_date),
        FOREIGN KEY (guild_id, discord_user_id) REFERENCES guild_members(guild_id, discord_user_id) ON DELETE CASCADE,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS queue_history (
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        wanikani_user_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        queue_size INTEGER NOT NULL,
        PRIMARY KEY (guild_id, discord_user_id, recorded_at),
        FOREIGN KEY (guild_id, discord_user_id) REFERENCES guild_members(guild_id, discord_user_id) ON DELETE CASCADE,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_queue_history_user_recorded ON queue_history(discord_user_id, guild_id, recorded_at)`,

    `CREATE TABLE IF NOT EXISTS review_stat_snapshots (
        wanikani_user_id TEXT NOT NULL,
        subject_id INTEGER NOT NULL,
        snapshot_date TEXT NOT NULL,
        meaning_incorrect INTEGER NOT NULL DEFAULT 0,
        reading_incorrect INTEGER NOT NULL DEFAULT 0,
        percentage_correct INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (wanikani_user_id, subject_id, snapshot_date),
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE,
        FOREIGN KEY (subject_id) REFERENCES wk_subjects(subject_id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS achievement_definitions (
        achievement_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS user_achievements (
        achievement_key TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        wanikani_user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL DEFAULT 'GLOBAL',
        unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metadata_json TEXT,
        PRIMARY KEY (achievement_key, discord_user_id, guild_id),
        FOREIGN KEY (achievement_key) REFERENCES achievement_definitions(achievement_key) ON DELETE CASCADE,
        FOREIGN KEY (discord_user_id) REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,
];

// Seed values for the built-in achievements. INSERT OR IGNORE so re-running
// the migration is safe and never clobbers any locally-edited descriptions.
const ACHIEVEMENTS_V2 = [
    ['first_burn',     'First Burn',          'Burn your first WaniKani item.',                      'burn'],
    ['100_burns',      'Centennial Burner',   'Burn 100 items.',                                     'burn'],
    ['500_burns',      'Pyromancer',          'Burn 500 items.',                                     'burn'],
    ['1000_burns',     'Inferno',             'Burn 1,000 items.',                                   'burn'],
    ['level_10',       'Pleasant',            'Reach WaniKani level 10.',                            'milestone'],
    ['level_30',       'Painful',             'Reach WaniKani level 30.',                            'milestone'],
    ['level_60',       'Reality',             'Reach WaniKani level 60 — the top.',                  'milestone'],
    ['streak_7',       'One Week Strong',     'Maintain a 7-day review streak.',                     'streak'],
    ['streak_30',      'One Month Strong',    'Maintain a 30-day review streak.',                    'streak'],
    ['streak_100',     'Hundred-Day Hero',    'Maintain a 100-day review streak.',                   'streak'],
    ['500_reviews',    'Half-Thousand Club',  'Complete 500 reviews tracked by the bot.',            'volume'],
    ['5000_reviews',   'Five-Thousand Club',  'Complete 5,000 reviews tracked by the bot.',          'volume'],
].map(([key, name, description, category]) => (
    `INSERT OR IGNORE INTO achievement_definitions (achievement_key, name, description, category)
     VALUES (${[key, name, description, category].map(s => `'${s.replace(/'/g, "''")}'`).join(', ')})`
));

const SCHEMA_V3 = [
    `ALTER TABLE long_goals ADD COLUMN last_alerted_review_count INTEGER`,
];

// Switch the legacy 'UTC' / '15:00' defaults to JST midnight. The wall-clock
// UTC instant for an existing guild on those defaults is unchanged (15:00 UTC
// == 00:00 Asia/Tokyo); the timezone label just becomes honest.
const SCHEMA_V4 = [
    `UPDATE guild_settings
        SET timezone = 'Asia/Tokyo',
            daily_summary_time = '00:00',
            updated_at = CURRENT_TIMESTAMP
      WHERE timezone = 'UTC' AND daily_summary_time = '15:00'`,
];

const SCHEMA_V5 = [
    `ALTER TABLE review_stat_snapshots ADD COLUMN meaning_correct INTEGER`,
    `ALTER TABLE review_stat_snapshots ADD COLUMN reading_correct INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_review_stat_snapshots_user_date
        ON review_stat_snapshots(wanikani_user_id, snapshot_date)`,
];

const SCHEMA_V6 = [
    `CREATE TABLE IF NOT EXISTS wk_review_stat_history (
        wanikani_user_id TEXT NOT NULL,
        review_statistic_id INTEGER NOT NULL,
        subject_id INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        meaning_correct INTEGER NOT NULL DEFAULT 0,
        meaning_incorrect INTEGER NOT NULL DEFAULT 0,
        reading_correct INTEGER NOT NULL DEFAULT 0,
        reading_incorrect INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (wanikani_user_id, subject_id, recorded_at),
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE,
        FOREIGN KEY (subject_id) REFERENCES wk_subjects(subject_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wk_review_stat_history_user_recorded
        ON wk_review_stat_history(wanikani_user_id, recorded_at)`,
    `INSERT OR IGNORE INTO wk_review_stat_history (
        wanikani_user_id, review_statistic_id, subject_id, recorded_at,
        meaning_correct, meaning_incorrect, reading_correct, reading_incorrect, hidden
     )
     SELECT wanikani_user_id, review_statistic_id, subject_id, data_updated_at,
            meaning_correct, meaning_incorrect, reading_correct, reading_incorrect, hidden
     FROM wk_review_statistics
     WHERE data_updated_at IS NOT NULL`,
];

const SCHEMA_V7 = [
    `CREATE TABLE IF NOT EXISTS command_usage (
        command_usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
        command_name TEXT NOT NULL,
        subcommand_name TEXT,
        guild_id TEXT,
        channel_id TEXT,
        discord_user_id TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT,
        duration_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'success', 'failed')),
        error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_command_usage_started_at
        ON command_usage(started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_command_usage_command_started
        ON command_usage(command_name, started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_command_usage_guild_started
        ON command_usage(guild_id, started_at)`,
];

// Zero out daily_snapshots rows polluted by the vacation-toggle bulk-update
// bug in scheduler.updateSnapshotsAndStreaks. No human realistically completes
// 500+ reviews or lessons in a single day; the only source of such rows is
// the bulk-updated-assignments bucketing bug fixed alongside this migration.
const SCHEMA_V8 = [
    `UPDATE daily_snapshots SET reviews_completed = 0 WHERE reviews_completed > 500`,
    `UPDATE daily_snapshots SET lessons_completed = 0 WHERE lessons_completed > 500`,
];

// Default reviews-cleared announcements were off in the original schema; flip
// existing guilds on so the feature actually fires. Admins can still disable
// via /config if they don't want it.
const SCHEMA_V9 = [
    `UPDATE guild_settings
        SET reviews_cleared_announcements_enabled = 1,
            updated_at = CURRENT_TIMESTAMP
      WHERE reviews_cleared_announcements_enabled = 0`,
];

// Reviews-available DMs used to share long_goals.last_alerted_* with the pace
// alert. Account-scoped columns let either path fire independently and let
// users without a long_goal receive the DM via reminder_settings.
const SCHEMA_V10 = [
    `ALTER TABLE wanikani_accounts ADD COLUMN last_reviews_alerted_at TEXT`,
    `ALTER TABLE wanikani_accounts ADD COLUMN last_reviews_alerted_count INTEGER`,
];

// Streak-risk reminder: a new per-user opt-in flag + an expanded
// reminder_events.reminder_type CHECK that includes 'streak_risk'. SQLite
// can't alter a CHECK constraint in place, so the events table is rebuilt.
const SCHEMA_V11 = [
    `ALTER TABLE reminder_settings ADD COLUMN streak_reminder_enabled INTEGER NOT NULL DEFAULT 1`,
    `CREATE TABLE reminder_events_v11 (
        reminder_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        wanikani_user_id TEXT NOT NULL,
        reminder_type TEXT NOT NULL CHECK (reminder_type IN ('reviews_available', 'lessons_available', 'reviews_cleared', 'daily_summary', 'shame', 'streak_risk')),
        review_count INTEGER,
        lesson_count INTEGER,
        scheduled_for TEXT,
        sent_at TEXT,
        delivery_target TEXT NOT NULL CHECK (delivery_target IN ('dm', 'channel')),
        discord_channel_id TEXT,
        discord_message_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id, discord_user_id) REFERENCES guild_members(guild_id, discord_user_id) ON DELETE CASCADE,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,
    `INSERT INTO reminder_events_v11 SELECT * FROM reminder_events`,
    `DROP TABLE reminder_events`,
    `ALTER TABLE reminder_events_v11 RENAME TO reminder_events`,
    `CREATE INDEX IF NOT EXISTS idx_reminder_events_pending ON reminder_events(status, scheduled_for)`,
    `CREATE INDEX IF NOT EXISTS idx_reminder_events_user_sent ON reminder_events(discord_user_id, sent_at)`,
];

// Guild-aggregate achievements. Definitions live alongside per-user ones; a
// 'guild_*' category prefix distinguishes them. Guild unlocks have their own
// table keyed only on (guild_id, achievement_key) — no user dimension.
const GUILD_ACHIEVEMENT_DEFS_V12 = [
    ['guild_10k_reviews',   'Ten Thousand Strong',   'Server members complete 10,000 cumulative reviews.',            'guild_volume'],
    ['guild_100k_reviews',  'Hundred Thousand Club', 'Server members complete 100,000 cumulative reviews.',           'guild_volume'],
    ['guild_1k_burns',      'Burned Together',       'Server members collectively burn 1,000 items.',                 'guild_burn'],
    ['guild_10k_burns',     'Pyre Brigade',          'Server members collectively burn 10,000 items.',                'guild_burn'],
    ['guild_all_level_10',  'Pleasant Together',     'Every member of the server reaches level 10 (needs ≥3 members).', 'guild_milestone'],
    ['guild_all_level_30',  'Painful Together',      'Every member of the server reaches level 30 (needs ≥3 members).', 'guild_milestone'],
    ['guild_streak_total_100', 'Streak Synergy',     'The server has 100 cumulative days of active streaks.',         'guild_streak'],
].map(([key, name, description, category]) => (
    `INSERT OR IGNORE INTO achievement_definitions (achievement_key, name, description, category)
     VALUES (${[key, name, description, category].map(s => `'${s.replace(/'/g, "''")}'`).join(', ')})`
));

const SCHEMA_V12 = [
    `CREATE TABLE IF NOT EXISTS guild_achievements (
        guild_id TEXT NOT NULL,
        achievement_key TEXT NOT NULL,
        unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metric_value INTEGER,
        PRIMARY KEY (guild_id, achievement_key),
        FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
        FOREIGN KEY (achievement_key) REFERENCES achievement_definitions(achievement_key) ON DELETE CASCADE
    )`,
    ...GUILD_ACHIEVEMENT_DEFS_V12,
];

// Split the overloaded `reviews_ping_enabled` flag into two: the existing
// column now exclusively controls the @mention in daily/weekly channel posts,
// while a new `reviews_dm_enabled` column controls the per-unlock review DM.
// Seed `reviews_dm_enabled` from the user's prior `reviews_ping_enabled` so
// existing opt-outs carry over without surprise re-enables.
const SCHEMA_V13 = [
    `ALTER TABLE reminder_settings ADD COLUMN reviews_dm_enabled INTEGER NOT NULL DEFAULT 1`,
    `UPDATE reminder_settings SET reviews_dm_enabled = reviews_ping_enabled`,
];

// Split reminder preferences into a true user-level layer (DM-style toggles,
// which are inherently cross-guild because they deliver via DM) and a
// per-guild layer (channel post opt-ins, where the guild context matters).
//
// New `user_reminder_settings` holds reviews_dm / streak / shame. Backfill
// takes MAX across the user's existing per-guild rows so any explicit opt-in
// (or shame opt-in) carries over; users who had everything off everywhere
// keep that state.
//
// `reminder_settings` keeps its per-guild scope but picks up new opt-out
// columns for the channel-post features that previously had no per-user
// override (weekly @mention, burn announcements, level-up announcements).
const SCHEMA_V14 = [
    `CREATE TABLE IF NOT EXISTS user_reminder_settings (
        discord_user_id TEXT PRIMARY KEY,
        reviews_dm_enabled INTEGER NOT NULL DEFAULT 1,
        streak_reminder_enabled INTEGER NOT NULL DEFAULT 1,
        shame_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (discord_user_id) REFERENCES discord_users(discord_user_id) ON DELETE CASCADE
    )`,
    `INSERT OR IGNORE INTO user_reminder_settings
        (discord_user_id, reviews_dm_enabled, streak_reminder_enabled, shame_enabled)
     SELECT discord_user_id,
            MAX(reviews_dm_enabled),
            MAX(streak_reminder_enabled),
            MAX(shame_enabled)
     FROM reminder_settings
     GROUP BY discord_user_id`,
    `ALTER TABLE reminder_settings ADD COLUMN burn_announcement_enabled INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE reminder_settings ADD COLUMN levelup_announcement_enabled INTEGER NOT NULL DEFAULT 1`,
];

// Optional quiet hours window per user. Hours are integers 0-23 interpreted in
// the user's primary guild timezone at send time. When both columns are non-null
// the DM-sending paths (reviews_available, streak_risk, shame) skip delivery
// while the current local hour is inside [start, end) — wrapping past midnight
// if end <= start.
const SCHEMA_V15 = [
    `ALTER TABLE user_reminder_settings ADD COLUMN sleep_start_hour INTEGER`,
    `ALTER TABLE user_reminder_settings ADD COLUMN sleep_end_hour INTEGER`,
];

// Single user-level goal model. Replaces both `long_goals` (user-level
// long-term) and `goals` (per-guild daily targets). Numeric daily *review*
// targets are gone — the SRS dictates how many reviews come due, so the only
// meaningful daily commitments are lessons/day (user-controlled) and
// "clear my review queue" (boolean). Pace fields (pace_mode, days_per_level,
// items_per_level, daily_reviews) are dropped: projections are recomputed
// live from WK data wherever they're shown.
//
// Backfill: long_goals rows carry over 1:1; per-guild goals collapse to the
// user level (MAX lessons target across guilds; `daily_all_reviews`, or a
// numeric review target >= 50 — intent was "do my reviews" — maps to
// clear_queue). `daily_all_lessons` is dropped (it fights SRS pacing).
// The old tables are kept for one release so rollback is trivial.
const SCHEMA_V16 = [
    `CREATE TABLE IF NOT EXISTS user_goals (
        discord_user_id TEXT PRIMARY KEY,
        wanikani_user_id TEXT NOT NULL,
        target_level INTEGER,
        deadline TEXT,
        hit_rate REAL,
        daily_lessons INTEGER,
        clear_queue INTEGER NOT NULL DEFAULT 0,
        notify_enabled INTEGER NOT NULL DEFAULT 1,
        last_alerted_at TEXT,
        last_projection_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (discord_user_id) REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
        FOREIGN KEY (wanikani_user_id) REFERENCES wanikani_accounts(wanikani_user_id) ON DELETE CASCADE
    )`,
    `INSERT OR IGNORE INTO user_goals
        (discord_user_id, wanikani_user_id, target_level, deadline, hit_rate,
         daily_lessons, notify_enabled, last_alerted_at, last_projection_at)
     SELECT discord_user_id, wanikani_user_id, target_level, deadline, hit_rate,
            daily_lessons, notify_enabled, last_alerted_at, last_projection_at
     FROM long_goals`,
    `INSERT INTO user_goals (discord_user_id, wanikani_user_id, daily_lessons, clear_queue)
     SELECT g.discord_user_id,
            wa.wanikani_user_id,
            NULLIF(MAX(g.daily_lessons), 0),
            MAX(CASE WHEN g.daily_all_reviews = 1 OR g.daily_reviews >= 50 THEN 1 ELSE 0 END)
     FROM goals g
     JOIN wanikani_accounts wa ON wa.discord_user_id = g.discord_user_id
     GROUP BY g.discord_user_id
     ON CONFLICT(discord_user_id) DO UPDATE SET
        daily_lessons = COALESCE(user_goals.daily_lessons, excluded.daily_lessons),
        clear_queue = MAX(user_goals.clear_queue, excluded.clear_queue),
        updated_at = CURRENT_TIMESTAMP`,
    // Daily goal-met result, finalized once per day by dailyJob for the day
    // being closed. NULL = the user had no goal that day.
    `ALTER TABLE daily_snapshots ADD COLUMN goal_met INTEGER`,
    `ALTER TABLE streaks ADD COLUMN goal_current_streak INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE streaks ADD COLUMN goal_longest_streak INTEGER NOT NULL DEFAULT 0`,
];

// Level-up announcement watermark + per-user timezone (explicit + inferred).
//
// `last_announced_level` decouples level-up detection from whoever refreshed
// `wanikani_accounts.level` last: the 5-minute summaryRefreshJob force-syncs
// /user, so by the time the hourly slowDetectionJob compared level
// before/after its own sync the diff was always zero and announcements never
// fired. Only the announcement path advances the watermark.
//
// Timezone columns: `timezone` is an explicit per-user override (/timezone);
// `inferred_timezone` is computed daily from activity patterns (review
// timestamps, queue drops, command usage) with a 0-1 confidence score.
// Effective zone precedence: override > confident inference > guild timezone.
// `discord_users.locale` caches interaction.locale to snap a raw UTC offset
// to a plausible IANA zone (which also gets DST right going forward).
const SCHEMA_V17 = [
    `ALTER TABLE wanikani_accounts ADD COLUMN last_announced_level INTEGER`,
    `ALTER TABLE discord_users ADD COLUMN locale TEXT`,
    `ALTER TABLE user_reminder_settings ADD COLUMN timezone TEXT`,
    `ALTER TABLE user_reminder_settings ADD COLUMN inferred_timezone TEXT`,
    `ALTER TABLE user_reminder_settings ADD COLUMN inferred_tz_confidence REAL`,
    `ALTER TABLE user_reminder_settings ADD COLUMN inferred_tz_updated_at TEXT`,
];

const MIGRATIONS = [
    { version: 1, name: 'initial_schema_v2', statements: SCHEMA_V1 },
    { version: 2, name: 'seed_achievements', statements: ACHIEVEMENTS_V2 },
    { version: 3, name: 'long_goals_alerted_count', statements: SCHEMA_V3 },
    { version: 4, name: 'jst_default_timezone', statements: SCHEMA_V4 },
    { version: 5, name: 'review_stat_snapshot_correct_counts', statements: SCHEMA_V5 },
    { version: 6, name: 'review_stat_counter_history', statements: SCHEMA_V6 },
    { version: 7, name: 'command_usage_log', statements: SCHEMA_V7 },
    { version: 8, name: 'zero_out_vacation_review_spikes', statements: SCHEMA_V8 },
    { version: 9, name: 'enable_cleared_announcements_default', statements: SCHEMA_V9 },
    { version: 10, name: 'wanikani_accounts_reviews_alerted', statements: SCHEMA_V10 },
    { version: 11, name: 'streak_risk_reminders', statements: SCHEMA_V11 },
    { version: 12, name: 'guild_achievements', statements: SCHEMA_V12 },
    { version: 13, name: 'split_reviews_ping_into_dm', statements: SCHEMA_V13 },
    { version: 14, name: 'user_level_reminder_settings', statements: SCHEMA_V14 },
    { version: 15, name: 'user_sleep_hours', statements: SCHEMA_V15 },
    { version: 16, name: 'user_goals_and_goal_streaks', statements: SCHEMA_V16 },
    { version: 17, name: 'levelup_watermark_and_user_timezone', statements: SCHEMA_V17 },
];

async function runMigrations({ get, all, run }) {
    await run(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    const applied = await all(`SELECT version FROM schema_migrations`);
    const appliedVersions = new Set(applied.map(r => r.version));

    for (const migration of MIGRATIONS) {
        if (appliedVersions.has(migration.version)) continue;
        for (const stmt of migration.statements) {
            await run(stmt);
        }
        await run(
            `INSERT INTO schema_migrations (version, name) VALUES (?, ?)`,
            [migration.version, migration.name]
        );
    }
}

module.exports = { runMigrations };
