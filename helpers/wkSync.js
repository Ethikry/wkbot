const db = require('../db');
const { decrypt } = require('./crypto');
const { wkRequest, wkRequestAllPages } = require('./wanikaniData');

// ── sync_state helpers ────────────────────────────────────────────────────

async function loadGlobalSyncState(endpoint) {
    return db.get(
        `SELECT etag, last_modified AS lastModified,
                last_data_updated_at AS lastDataUpdatedAt,
                last_synced_at AS lastSyncedAt
         FROM wk_global_sync_state WHERE endpoint = ?`,
        [endpoint]
    );
}

async function saveGlobalSyncState(endpoint, { etag, lastModified, dataUpdatedAt, status, error }) {
    await db.run(
        `INSERT INTO wk_global_sync_state
            (endpoint, last_synced_at, last_data_updated_at, etag, last_modified, last_status_code, last_error)
         VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
            last_synced_at = CURRENT_TIMESTAMP,
            last_data_updated_at = COALESCE(excluded.last_data_updated_at, wk_global_sync_state.last_data_updated_at),
            etag = COALESCE(excluded.etag, wk_global_sync_state.etag),
            last_modified = COALESCE(excluded.last_modified, wk_global_sync_state.last_modified),
            last_status_code = excluded.last_status_code,
            last_error = excluded.last_error,
            updated_at = CURRENT_TIMESTAMP`,
        [endpoint, dataUpdatedAt ?? null, etag ?? null, lastModified ?? null, status ?? null, error ?? null]
    );
}

async function loadUserSyncState(wanikaniUserId, endpoint) {
    return db.get(
        `SELECT etag, last_modified AS lastModified,
                last_data_updated_at AS lastDataUpdatedAt,
                last_synced_at AS lastSyncedAt
         FROM wk_sync_state WHERE wanikani_user_id = ? AND endpoint = ?`,
        [wanikaniUserId, endpoint]
    );
}

async function saveUserSyncState(wanikaniUserId, endpoint, { etag, lastModified, dataUpdatedAt, status, error }) {
    await db.run(
        `INSERT INTO wk_sync_state
            (wanikani_user_id, endpoint, last_synced_at, last_data_updated_at,
             etag, last_modified, last_status_code, last_error)
         VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)
         ON CONFLICT(wanikani_user_id, endpoint) DO UPDATE SET
            last_synced_at = CURRENT_TIMESTAMP,
            last_data_updated_at = COALESCE(excluded.last_data_updated_at, wk_sync_state.last_data_updated_at),
            etag = COALESCE(excluded.etag, wk_sync_state.etag),
            last_modified = COALESCE(excluded.last_modified, wk_sync_state.last_modified),
            last_status_code = excluded.last_status_code,
            last_error = excluded.last_error,
            updated_at = CURRENT_TIMESTAMP`,
        [wanikaniUserId, endpoint, dataUpdatedAt ?? null, etag ?? null, lastModified ?? null, status ?? null, error ?? null]
    );
}

function buildIncrementalUrl(path, since) {
    if (!since) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}updated_after=${encodeURIComponent(since)}`;
}

// ── subjects (global) ─────────────────────────────────────────────────────

async function upsertSubject(item) {
    const d = item.data ?? {};
    await db.run(
        `INSERT INTO wk_subjects (
            subject_id, object, url, data_updated_at, subject_type, level, slug,
            characters, document_url, meaning_mnemonic, reading_mnemonic,
            lesson_position, spaced_repetition_system_id, hidden_at, raw_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subject_id) DO UPDATE SET
            object = excluded.object, url = excluded.url,
            data_updated_at = excluded.data_updated_at,
            subject_type = excluded.subject_type, level = excluded.level,
            slug = excluded.slug, characters = excluded.characters,
            document_url = excluded.document_url,
            meaning_mnemonic = excluded.meaning_mnemonic,
            reading_mnemonic = excluded.reading_mnemonic,
            lesson_position = excluded.lesson_position,
            spaced_repetition_system_id = excluded.spaced_repetition_system_id,
            hidden_at = excluded.hidden_at,
            raw_json = excluded.raw_json,
            updated_at = CURRENT_TIMESTAMP`,
        [
            item.id, item.object, item.url, item.data_updated_at,
            item.object, d.level ?? null, d.slug ?? null, d.characters ?? null,
            d.document_url ?? null, d.meaning_mnemonic ?? null, d.reading_mnemonic ?? null,
            d.lesson_position ?? null, d.spaced_repetition_system_id ?? null,
            d.hidden_at ?? null, JSON.stringify(item), d.created_at ?? null,
        ]
    );
}

async function syncSubjects(apiKey) {
    const state = await loadGlobalSyncState('subjects');
    const url = buildIncrementalUrl('/subjects', state?.lastDataUpdatedAt);
    try {
        const res = await wkRequestAllPages(url, apiKey, {
            conditional: state?.lastDataUpdatedAt ? null : { etag: state?.etag, lastModified: state?.lastModified },
        });
        for (const item of res.items) await upsertSubject(item);
        await saveGlobalSyncState('subjects', {
            etag: res.etag, lastModified: res.lastModified,
            dataUpdatedAt: res.dataUpdatedAt ?? new Date().toISOString(),
            status: res.notModified ? 304 : 200,
        });
        return { synced: res.items.length, notModified: res.notModified };
    } catch (err) {
        await saveGlobalSyncState('subjects', { status: 0, error: err.message });
        throw err;
    }
}

// ── spaced_repetition_systems (global) ────────────────────────────────────

async function upsertSrsSystem(item) {
    const d = item.data ?? {};
    await db.run(
        `INSERT INTO wk_spaced_repetition_systems (
            srs_id, object, url, data_updated_at, name, description,
            unlocking_stage_position, starting_stage_position,
            passing_stage_position, burning_stage_position,
            raw_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(srs_id) DO UPDATE SET
            object = excluded.object, url = excluded.url,
            data_updated_at = excluded.data_updated_at,
            name = excluded.name, description = excluded.description,
            unlocking_stage_position = excluded.unlocking_stage_position,
            starting_stage_position = excluded.starting_stage_position,
            passing_stage_position = excluded.passing_stage_position,
            burning_stage_position = excluded.burning_stage_position,
            raw_json = excluded.raw_json,
            updated_at = CURRENT_TIMESTAMP`,
        [
            item.id, item.object, item.url, item.data_updated_at,
            d.name ?? '', d.description ?? null,
            d.unlocking_stage_position ?? null, d.starting_stage_position ?? null,
            d.passing_stage_position ?? null, d.burning_stage_position ?? null,
            JSON.stringify(item), d.created_at ?? null,
        ]
    );
    await db.run(`DELETE FROM wk_srs_stages WHERE srs_id = ?`, [item.id]);
    for (const stage of d.stages ?? []) {
        await db.run(
            `INSERT INTO wk_srs_stages (srs_id, position, interval, interval_unit) VALUES (?, ?, ?, ?)`,
            [item.id, stage.position, stage.interval ?? null, stage.interval_unit ?? null]
        );
    }
}

async function syncSpacedRepetitionSystems(apiKey) {
    const state = await loadGlobalSyncState('spaced_repetition_systems');
    try {
        const res = await wkRequestAllPages('/spaced_repetition_systems', apiKey, {
            conditional: { etag: state?.etag, lastModified: state?.lastModified },
        });
        for (const item of res.items) await upsertSrsSystem(item);
        await saveGlobalSyncState('spaced_repetition_systems', {
            etag: res.etag, lastModified: res.lastModified,
            dataUpdatedAt: res.dataUpdatedAt ?? new Date().toISOString(),
            status: res.notModified ? 304 : 200,
        });
        return { synced: res.items.length, notModified: res.notModified };
    } catch (err) {
        await saveGlobalSyncState('spaced_repetition_systems', { status: 0, error: err.message });
        throw err;
    }
}

// ── assignments (per-user) ────────────────────────────────────────────────

async function upsertAssignment(wanikaniUserId, item) {
    const d = item.data ?? {};
    await db.run(
        `INSERT INTO wk_assignments (
            assignment_id, wanikani_user_id, object, url, data_updated_at,
            subject_id, subject_type, level, srs_stage,
            unlocked_at, started_at, passed_at, burned_at, available_at, resurrected_at,
            hidden, raw_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(assignment_id) DO UPDATE SET
            object = excluded.object, url = excluded.url,
            data_updated_at = excluded.data_updated_at,
            subject_id = excluded.subject_id, subject_type = excluded.subject_type,
            level = excluded.level, srs_stage = excluded.srs_stage,
            unlocked_at = excluded.unlocked_at, started_at = excluded.started_at,
            passed_at = excluded.passed_at, burned_at = excluded.burned_at,
            available_at = excluded.available_at,
            resurrected_at = excluded.resurrected_at,
            hidden = excluded.hidden, raw_json = excluded.raw_json,
            updated_at = CURRENT_TIMESTAMP`,
        [
            item.id, wanikaniUserId, item.object, item.url, item.data_updated_at,
            d.subject_id, d.subject_type, d.level ?? null, d.srs_stage ?? 0,
            d.unlocked_at ?? null, d.started_at ?? null, d.passed_at ?? null,
            d.burned_at ?? null, d.available_at ?? null, d.resurrected_at ?? null,
            d.hidden ? 1 : 0, JSON.stringify(item), d.created_at ?? null,
        ]
    );
}

async function syncAssignments(account) {
    const apiKey = decrypt(account.api_token_encrypted);
    const wkId = account.wanikani_user_id;
    const state = await loadUserSyncState(wkId, 'assignments');
    const url = buildIncrementalUrl('/assignments', state?.lastDataUpdatedAt);
    try {
        const res = await wkRequestAllPages(url, apiKey, {
            conditional: state?.lastDataUpdatedAt ? null : { etag: state?.etag, lastModified: state?.lastModified },
        });
        for (const item of res.items) await upsertAssignment(wkId, item);
        await saveUserSyncState(wkId, 'assignments', {
            etag: res.etag, lastModified: res.lastModified,
            dataUpdatedAt: res.dataUpdatedAt ?? new Date().toISOString(),
            status: res.notModified ? 304 : 200,
        });
        return { synced: res.items.length, notModified: res.notModified };
    } catch (err) {
        await saveUserSyncState(wkId, 'assignments', { status: 0, error: err.message });
        throw err;
    }
}

// ── review_statistics (per-user) ──────────────────────────────────────────

async function upsertReviewStatistic(wanikaniUserId, item) {
    const d = item.data ?? {};
    const recordedAt = item.data_updated_at ?? new Date().toISOString();
    await db.run(
        `INSERT INTO wk_review_statistics (
            review_statistic_id, wanikani_user_id, object, url, data_updated_at,
            subject_id, subject_type,
            meaning_correct, meaning_incorrect, meaning_max_streak, meaning_current_streak,
            reading_correct, reading_incorrect, reading_max_streak, reading_current_streak,
            percentage_correct, hidden, raw_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(review_statistic_id) DO UPDATE SET
            object = excluded.object, url = excluded.url,
            data_updated_at = excluded.data_updated_at,
            subject_id = excluded.subject_id, subject_type = excluded.subject_type,
            meaning_correct = excluded.meaning_correct,
            meaning_incorrect = excluded.meaning_incorrect,
            meaning_max_streak = excluded.meaning_max_streak,
            meaning_current_streak = excluded.meaning_current_streak,
            reading_correct = excluded.reading_correct,
            reading_incorrect = excluded.reading_incorrect,
            reading_max_streak = excluded.reading_max_streak,
            reading_current_streak = excluded.reading_current_streak,
            percentage_correct = excluded.percentage_correct,
            hidden = excluded.hidden, raw_json = excluded.raw_json,
            updated_at = CURRENT_TIMESTAMP`,
        [
            item.id, wanikaniUserId, item.object, item.url, item.data_updated_at,
            d.subject_id, d.subject_type,
            d.meaning_correct ?? 0, d.meaning_incorrect ?? 0,
            d.meaning_max_streak ?? 0, d.meaning_current_streak ?? 0,
            d.reading_correct ?? 0, d.reading_incorrect ?? 0,
            d.reading_max_streak ?? 0, d.reading_current_streak ?? 0,
            d.percentage_correct ?? 0, d.hidden ? 1 : 0,
            JSON.stringify(item), d.created_at ?? null,
        ]
    );
    await db.run(
        `INSERT INTO wk_review_stat_history (
            wanikani_user_id, review_statistic_id, subject_id, recorded_at,
            meaning_correct, meaning_incorrect, reading_correct, reading_incorrect, hidden
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(wanikani_user_id, subject_id, recorded_at) DO UPDATE SET
            review_statistic_id = excluded.review_statistic_id,
            meaning_correct = excluded.meaning_correct,
            meaning_incorrect = excluded.meaning_incorrect,
            reading_correct = excluded.reading_correct,
            reading_incorrect = excluded.reading_incorrect,
            hidden = excluded.hidden`,
        [
            wanikaniUserId, item.id, d.subject_id, recordedAt,
            d.meaning_correct ?? 0, d.meaning_incorrect ?? 0,
            d.reading_correct ?? 0, d.reading_incorrect ?? 0,
            d.hidden ? 1 : 0,
        ]
    );
}

async function syncReviewStatistics(account) {
    const apiKey = decrypt(account.api_token_encrypted);
    const wkId = account.wanikani_user_id;
    const state = await loadUserSyncState(wkId, 'review_statistics');
    const url = buildIncrementalUrl('/review_statistics', state?.lastDataUpdatedAt);
    try {
        const res = await wkRequestAllPages(url, apiKey, {
            conditional: state?.lastDataUpdatedAt ? null : { etag: state?.etag, lastModified: state?.lastModified },
        });
        for (const item of res.items) await upsertReviewStatistic(wkId, item);
        await saveUserSyncState(wkId, 'review_statistics', {
            etag: res.etag, lastModified: res.lastModified,
            dataUpdatedAt: res.dataUpdatedAt ?? new Date().toISOString(),
            status: res.notModified ? 304 : 200,
        });
        return { synced: res.items.length, notModified: res.notModified };
    } catch (err) {
        await saveUserSyncState(wkId, 'review_statistics', { status: 0, error: err.message });
        throw err;
    }
}

// ── level_progressions (per-user) ─────────────────────────────────────────

async function upsertLevelProgression(wanikaniUserId, item) {
    const d = item.data ?? {};
    await db.run(
        `INSERT INTO wk_level_progressions (
            level_progression_id, wanikani_user_id, object, url, data_updated_at,
            level, unlocked_at, started_at, passed_at, completed_at, abandoned_at,
            raw_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(level_progression_id) DO UPDATE SET
            object = excluded.object, url = excluded.url,
            data_updated_at = excluded.data_updated_at,
            level = excluded.level,
            unlocked_at = excluded.unlocked_at,
            started_at = excluded.started_at,
            passed_at = excluded.passed_at,
            completed_at = excluded.completed_at,
            abandoned_at = excluded.abandoned_at,
            raw_json = excluded.raw_json,
            updated_at = CURRENT_TIMESTAMP`,
        [
            item.id, wanikaniUserId, item.object, item.url, item.data_updated_at,
            d.level ?? 0, d.unlocked_at ?? null, d.started_at ?? null,
            d.passed_at ?? null, d.completed_at ?? null, d.abandoned_at ?? null,
            JSON.stringify(item), d.created_at ?? null,
        ]
    );
}

async function syncLevelProgressions(account) {
    const apiKey = decrypt(account.api_token_encrypted);
    const wkId = account.wanikani_user_id;
    const state = await loadUserSyncState(wkId, 'level_progressions');
    const url = buildIncrementalUrl('/level_progressions', state?.lastDataUpdatedAt);
    try {
        const res = await wkRequestAllPages(url, apiKey, {
            conditional: state?.lastDataUpdatedAt ? null : { etag: state?.etag, lastModified: state?.lastModified },
        });
        for (const item of res.items) await upsertLevelProgression(wkId, item);
        await saveUserSyncState(wkId, 'level_progressions', {
            etag: res.etag, lastModified: res.lastModified,
            dataUpdatedAt: res.dataUpdatedAt ?? new Date().toISOString(),
            status: res.notModified ? 304 : 200,
        });
        return { synced: res.items.length, notModified: res.notModified };
    } catch (err) {
        await saveUserSyncState(wkId, 'level_progressions', { status: 0, error: err.message });
        throw err;
    }
}

// ── study_materials (per-user) ────────────────────────────────────────────

async function upsertStudyMaterial(wanikaniUserId, item) {
    const d = item.data ?? {};
    await db.run(
        `INSERT INTO wk_study_materials (
            study_material_id, wanikani_user_id, object, url, data_updated_at,
            subject_id, subject_type,
            meaning_note, reading_note, meaning_synonyms_json,
            hidden, raw_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(study_material_id) DO UPDATE SET
            object = excluded.object, url = excluded.url,
            data_updated_at = excluded.data_updated_at,
            subject_id = excluded.subject_id, subject_type = excluded.subject_type,
            meaning_note = excluded.meaning_note,
            reading_note = excluded.reading_note,
            meaning_synonyms_json = excluded.meaning_synonyms_json,
            hidden = excluded.hidden, raw_json = excluded.raw_json,
            updated_at = CURRENT_TIMESTAMP`,
        [
            item.id, wanikaniUserId, item.object, item.url, item.data_updated_at,
            d.subject_id, d.subject_type,
            d.meaning_note ?? null, d.reading_note ?? null,
            d.meaning_synonyms ? JSON.stringify(d.meaning_synonyms) : null,
            d.hidden ? 1 : 0, JSON.stringify(item), d.created_at ?? null,
        ]
    );
}

async function syncStudyMaterials(account) {
    const apiKey = decrypt(account.api_token_encrypted);
    const wkId = account.wanikani_user_id;
    const state = await loadUserSyncState(wkId, 'study_materials');
    const url = buildIncrementalUrl('/study_materials', state?.lastDataUpdatedAt);
    try {
        const res = await wkRequestAllPages(url, apiKey, {
            conditional: state?.lastDataUpdatedAt ? null : { etag: state?.etag, lastModified: state?.lastModified },
        });
        for (const item of res.items) await upsertStudyMaterial(wkId, item);
        await saveUserSyncState(wkId, 'study_materials', {
            etag: res.etag, lastModified: res.lastModified,
            dataUpdatedAt: res.dataUpdatedAt ?? new Date().toISOString(),
            status: res.notModified ? 304 : 200,
        });
        return { synced: res.items.length, notModified: res.notModified };
    } catch (err) {
        await saveUserSyncState(wkId, 'study_materials', { status: 0, error: err.message });
        throw err;
    }
}

// ── /user (per-user) ──────────────────────────────────────────────────────

async function syncUser(account) {
    const apiKey = decrypt(account.api_token_encrypted);
    const wkId = account.wanikani_user_id;
    const state = await loadUserSyncState(wkId, 'user');
    try {
        const res = await wkRequest('/user', apiKey, {
            conditional: { etag: state?.etag, lastModified: state?.lastModified },
        });
        if (!res.notModified) {
            const d = res.data?.data ?? {};
            const sub = d.subscription ?? {};
            await db.run(
                `UPDATE wanikani_accounts SET
                    username = ?,
                    profile_url = ?,
                    level = ?,
                    started_at = ?,
                    current_vacation_started_at = ?,
                    subscription_active = ?,
                    subscription_type = ?,
                    max_level_granted = ?,
                    subscription_period_ends_at = ?,
                    last_user_sync_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE wanikani_user_id = ?`,
                [
                    d.username, d.profile_url ?? null, d.level,
                    d.started_at ?? null, d.current_vacation_started_at ?? null,
                    sub.active === undefined ? null : (sub.active ? 1 : 0),
                    sub.type ?? null, sub.max_level_granted ?? null,
                    sub.period_ends_at ?? null, wkId,
                ]
            );
        }
        await saveUserSyncState(wkId, 'user', {
            etag: res.etag, lastModified: res.lastModified,
            dataUpdatedAt: res.dataUpdatedAt,
            status: res.notModified ? 304 : 200,
        });
        return { notModified: res.notModified, data: res.data?.data ?? null };
    } catch (err) {
        await saveUserSyncState(wkId, 'user', { status: 0, error: err.message });
        throw err;
    }
}

// ── /summary (per-user) ───────────────────────────────────────────────────

async function syncSummary(account) {
    const apiKey = decrypt(account.api_token_encrypted);
    const wkId = account.wanikani_user_id;
    const state = await loadUserSyncState(wkId, 'summary');
    try {
        const res = await wkRequest('/summary', apiKey, {
            conditional: { etag: state?.etag, lastModified: state?.lastModified },
        });
        if (!res.notModified) {
            const body = res.data ?? {};
            const d = body.data ?? {};
            const now = new Date();

            const lessonBuckets = (d.lessons || []).filter(b => (b.subject_ids || []).length);
            const reviewBuckets = (d.reviews || []).filter(b => (b.subject_ids || []).length);

            const lessonCount = lessonBuckets.reduce((acc, b) => acc + b.subject_ids.length, 0);
            const reviewNow = reviewBuckets
                .filter(b => new Date(b.available_at) <= now)
                .reduce((acc, b) => acc + b.subject_ids.length, 0);
            const review24h = reviewBuckets
                .reduce((acc, b) => acc + b.subject_ids.length, 0);

            await db.run(
                `INSERT INTO wk_summary_cache (
                    wanikani_user_id, data_updated_at, next_reviews_at,
                    lesson_count, review_count_now, review_count_24h, raw_json, fetched_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(wanikani_user_id) DO UPDATE SET
                    data_updated_at = excluded.data_updated_at,
                    next_reviews_at = excluded.next_reviews_at,
                    lesson_count = excluded.lesson_count,
                    review_count_now = excluded.review_count_now,
                    review_count_24h = excluded.review_count_24h,
                    raw_json = excluded.raw_json,
                    fetched_at = CURRENT_TIMESTAMP`,
                [
                    wkId, body.data_updated_at ?? null, d.next_reviews_at ?? null,
                    lessonCount, reviewNow, review24h, JSON.stringify(body),
                ]
            );

            await db.run(`DELETE FROM wk_summary_buckets WHERE wanikani_user_id = ?`, [wkId]);
            for (const b of lessonBuckets) {
                await db.run(
                    `INSERT INTO wk_summary_buckets (wanikani_user_id, bucket_type, available_at, subject_ids_json, subject_count)
                     VALUES (?, 'lesson', ?, ?, ?)`,
                    [wkId, b.available_at, JSON.stringify(b.subject_ids), b.subject_ids.length]
                );
            }
            for (const b of reviewBuckets) {
                await db.run(
                    `INSERT OR REPLACE INTO wk_summary_buckets (wanikani_user_id, bucket_type, available_at, subject_ids_json, subject_count)
                     VALUES (?, 'review', ?, ?, ?)`,
                    [wkId, b.available_at, JSON.stringify(b.subject_ids), b.subject_ids.length]
                );
            }
        }
        await saveUserSyncState(wkId, 'summary', {
            etag: res.etag, lastModified: res.lastModified,
            dataUpdatedAt: res.dataUpdatedAt,
            status: res.notModified ? 304 : 200,
        });
        return { notModified: res.notModified, raw: res.data };
    } catch (err) {
        await saveUserSyncState(wkId, 'summary', { status: 0, error: err.message });
        throw err;
    }
}

// ── orchestration ─────────────────────────────────────────────────────────

// One-shot startup pass. Cheap on subsequent runs because of updated_after.
async function syncGlobals(apiKey) {
    const out = {};
    out.spacedRepetitionSystems = await syncSpacedRepetitionSystems(apiKey).catch(e => ({ error: e.message }));
    out.subjects = await syncSubjects(apiKey).catch(e => ({ error: e.message }));
    return out;
}

// Refresh the per-user caches needed for live commands. Order matters:
// /summary is the cheapest signal of whether anything changed at all.
async function syncUserAll(account) {
    const out = {};
    out.user = await syncUser(account).catch(e => ({ error: e.message }));
    out.summary = await syncSummary(account).catch(e => ({ error: e.message }));
    out.assignments = await syncAssignments(account).catch(e => ({ error: e.message }));
    out.reviewStatistics = await syncReviewStatistics(account).catch(e => ({ error: e.message }));
    out.levelProgressions = await syncLevelProgressions(account).catch(e => ({ error: e.message }));
    out.studyMaterials = await syncStudyMaterials(account).catch(e => ({ error: e.message }));
    await db.run(
        `UPDATE wanikani_accounts SET last_full_sync_at = CURRENT_TIMESTAMP WHERE wanikani_user_id = ?`,
        [account.wanikani_user_id]
    );
    return out;
}

module.exports = {
    loadGlobalSyncState, saveGlobalSyncState,
    loadUserSyncState, saveUserSyncState,
    syncSubjects, syncSpacedRepetitionSystems, syncGlobals,
    syncAssignments, syncReviewStatistics, syncLevelProgressions,
    syncStudyMaterials,
    syncUser, syncSummary, syncUserAll,
};
