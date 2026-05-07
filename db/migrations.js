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
        timezone TEXT NOT NULL DEFAULT 'UTC',
        daily_summary_enabled INTEGER NOT NULL DEFAULT 1,
        daily_summary_time TEXT NOT NULL DEFAULT '15:00',
        morning_ping_enabled INTEGER NOT NULL DEFAULT 0,
        morning_ping_time TEXT NOT NULL DEFAULT '08:00',
        shame_mode_enabled INTEGER NOT NULL DEFAULT 0,
        shame_time TEXT NOT NULL DEFAULT '22:00',
        weekly_leaderboard_enabled INTEGER NOT NULL DEFAULT 1,
        weekly_leaderboard_day INTEGER NOT NULL DEFAULT 0,
        weekly_leaderboard_time TEXT NOT NULL DEFAULT '20:00',
        level_up_announcements_enabled INTEGER NOT NULL DEFAULT 1,
        burn_celebrations_enabled INTEGER NOT NULL DEFAULT 1,
        reviews_cleared_announcements_enabled INTEGER NOT NULL DEFAULT 0,
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
        shame_enabled INTEGER NOT NULL DEFAULT 0,
        cleared_enabled INTEGER NOT NULL DEFAULT 1,
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

    `CREATE TABLE IF NOT EXISTS reminder_events (
        reminder_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        wanikani_user_id TEXT NOT NULL,
        reminder_type TEXT NOT NULL CHECK (reminder_type IN ('reviews_available', 'lessons_available', 'reviews_cleared', 'daily_summary', 'shame')),
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

const MIGRATIONS = [
    { version: 1, name: 'initial_schema_v2', statements: SCHEMA_V1 },
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
