const db = require('../db');

// Write a review_stat_snapshots row per known subject for the given user at
// the given guild-local date key. Used by the daily snapshot job for ongoing
// history and by /setup to seed a backdated baseline so /mistakes works for
// brand-new accounts (otherwise it would need a 7-day warm-up).
async function writeReviewStatSnapshots(wanikaniUserId, dateKey) {
    const stats = await db.all(
        `SELECT subject_id, meaning_incorrect, reading_incorrect, percentage_correct,
                meaning_correct, reading_correct
         FROM wk_review_statistics
         WHERE wanikani_user_id = ? AND hidden = 0`,
        [wanikaniUserId]
    );
    for (const s of stats) {
        await db.run(
            `INSERT INTO review_stat_snapshots (
                wanikani_user_id, subject_id, snapshot_date,
                meaning_incorrect, reading_incorrect, percentage_correct,
                meaning_correct, reading_correct
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(wanikani_user_id, subject_id, snapshot_date) DO UPDATE SET
                meaning_incorrect = excluded.meaning_incorrect,
                reading_incorrect = excluded.reading_incorrect,
                percentage_correct = excluded.percentage_correct,
                meaning_correct = excluded.meaning_correct,
                reading_correct = excluded.reading_correct`,
            [
                wanikaniUserId, s.subject_id, dateKey,
                s.meaning_incorrect || 0,
                s.reading_incorrect || 0,
                s.percentage_correct || 0,
                s.meaning_correct || 0,
                s.reading_correct || 0,
            ]
        );
    }
    return stats.length;
}

module.exports = { writeReviewStatSnapshots };
