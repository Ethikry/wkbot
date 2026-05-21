const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { fetchAllPages, getSubjectsByIds } = require('../helpers/wanikaniData');
const { getAccountForDiscordUser } = require('../helpers/userLink');
const { decrypt } = require('../helpers/crypto');
const { base, error } = require('../helpers/embeds');
const { botDateKey, addDaysToDateKey, resolveTimeZone } = require('../helpers/botTime');
const { writeReviewStatSnapshots } = require('../helpers/reviewStatSnapshot');
const db = require('../db');

const MISTAKE_WINDOW_DAYS = 7;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mistakes')
        .setDescription('Show your WaniKani mistakes from the past week (answers in spoilers)')
        .setDMPermission(false),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        const account = await getAccountForDiscordUser(userId);
        if (!account?.api_token_encrypted) {
            return interaction.reply({
                embeds: [error('No API Key', 'Set your WaniKani key with `/setup apikey:<token>` first.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const apiKey = decrypt(account.api_token_encrypted);
            const wanikaniUserId = account.wanikani_user_id;
            const cutoff = new Date(Date.now() - MISTAKE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
            const sinceISO = cutoff.toISOString();

            // Review records are deprecated in WaniKani API v2, so use review_statistics:
            // these are the subjects whose cumulative review stats changed during the window.
            const currentStats = await fetchAllPages(
                `/review_statistics?updated_after=${encodeURIComponent(sinceISO)}&hidden=false`,
                apiKey
            );

            if (currentStats.length === 0) {
                return interaction.editReply({
                    embeds: [base('📭 No Data Yet')
                        .setDescription('No reviewed items were found in the past 7 days. Check back after WaniKani records new review activity.')],
                });
            }

            const subjectIds = [
                ...new Set(currentStats.map(s => s.data?.subject_id).filter(id => id !== undefined && id !== null)),
            ];
            if (subjectIds.length === 0) {
                return interaction.editReply({
                    embeds: [base('📭 No Data Yet')
                        .setDescription('No review-stat subjects were found in the past 7 days.')],
                });
            }

            // Latest stored daily snapshot at or before the window start. This
            // is the pre-window cumulative incorrect count for each subject.
            const settings = await db.get(`SELECT timezone FROM guild_settings WHERE guild_id = ?`, [guildId]);
            const cutoffDateKey = botDateKey(cutoff, resolveTimeZone(settings?.timezone));
            const placeholders = subjectIds.map(() => '?').join(',');
            const snapRows = await db.all(
                `WITH latest AS (
                    SELECT subject_id, MAX(snapshot_date) AS snapshot_date
                    FROM review_stat_snapshots
                    WHERE wanikani_user_id = ?
                      AND subject_id IN (${placeholders})
                      AND snapshot_date <= ?
                    GROUP BY subject_id
                 )
                 SELECT s.subject_id, s.meaning_incorrect, s.reading_incorrect
                 FROM review_stat_snapshots s
                 JOIN latest l
                   ON l.subject_id = s.subject_id
                  AND l.snapshot_date = s.snapshot_date
                 WHERE s.wanikani_user_id = ?`,
                [wanikaniUserId, ...subjectIds, cutoffDateKey, wanikaniUserId]
            );
            let baselineMap = new Map(snapRows.map(r => [r.subject_id, r]));

            // Backfill: if any reviewed subjects have no pre-window snapshot
            // (existing users from before the setup-time baseline landed), seed
            // one at the cutoff date using current cumulative counts. Net
            // effect is "no mistakes counted for pre-baseline period" — honest
            // rather than skipping the subject entirely.
            const missingSubjectIds = subjectIds.filter(id => !baselineMap.has(id));
            if (missingSubjectIds.length > 0) {
                const backfillDateKey = addDaysToDateKey(cutoffDateKey, -1);
                await writeReviewStatSnapshots(account.wanikani_user_id, backfillDateKey);
                const backfilled = await db.all(
                    `SELECT subject_id, meaning_incorrect, reading_incorrect
                     FROM review_stat_snapshots
                     WHERE wanikani_user_id = ?
                       AND subject_id IN (${missingSubjectIds.map(() => '?').join(',')})
                       AND snapshot_date = ?`,
                    [wanikaniUserId, ...missingSubjectIds, backfillDateKey]
                );
                for (const r of backfilled) baselineMap.set(r.subject_id, r);
            }

            let skippedForBaseline = 0;
            const errored = currentStats.map(s => {
                const createdAt = s.data.created_at ? new Date(s.data.created_at) : null;
                const meaningTotal = s.data.meaning_incorrect || 0;
                const readingTotal = s.data.reading_incorrect || 0;

                if (createdAt && createdAt >= cutoff) {
                    if (meaningTotal === 0 && readingTotal === 0) return null;
                    return { stat: s, meaningDelta: meaningTotal, readingDelta: readingTotal };
                }

                const base = baselineMap.get(s.data.subject_id);
                if (!base) {
                    skippedForBaseline++;
                    return null;
                }
                const prevMeaning = base?.meaning_incorrect ?? 0;
                const prevReading = base?.reading_incorrect ?? 0;
                const meaningDelta = Math.max(0, meaningTotal - prevMeaning);
                const readingDelta = Math.max(0, readingTotal - prevReading);
                if (meaningDelta === 0 && readingDelta === 0) return null;
                return { stat: s, meaningDelta, readingDelta };
            }).filter(Boolean);

            if (errored.length === 0) {
                const desc = skippedForBaseline > 0
                    ? `No confirmed mistakes found. The bot is still building a pre-window baseline for ${skippedForBaseline} recently reviewed item${skippedForBaseline === 1 ? '' : 's'}.`
                    : 'You haven\'t missed a single review in the past 7 days. Nice.';
                return interaction.editReply({
                    embeds: [base(skippedForBaseline > 0 ? '📊 Building Baseline…' : '🎯 No Mistakes!')
                        .setDescription(desc)],
                });
            }

            const subjectIdsErrored = errored.map(e => e.stat.data.subject_id);
            const subjects = await getSubjectsByIds(apiKey, subjectIdsErrored);
            const subjectMap = new Map(subjects.map(s => [s.id, s.data]));

            // User-defined meaning synonyms from wk_study_materials.
            const placeholders2 = subjectIdsErrored.map(() => '?').join(',');
            const synonymRows = subjectIdsErrored.length
                ? await db.all(
                    `SELECT subject_id, meaning_synonyms_json FROM wk_study_materials
                     WHERE wanikani_user_id = ? AND subject_id IN (${placeholders2})`,
                    [wanikaniUserId, ...subjectIdsErrored]
                )
                : [];
            const synonymMap = new Map(synonymRows.map(r => [r.subject_id, r.meaning_synonyms_json ? JSON.parse(r.meaning_synonyms_json) : []]));

            const items = errored.map(e => {
                const subjectId = e.stat.data.subject_id;
                const subj = subjectMap.get(subjectId);
                if (!subj) return null;
                const meanings = (subj.meanings || []).map(m => m.meaning).filter(Boolean);
                const synonyms = synonymMap.get(subjectId) ?? [];
                return {
                    subjectId,
                    characters: subj.characters || subj.slug || '?',
                    meanings: [...meanings, ...synonyms],
                    readings: (subj.readings || []).filter(r => r.accepted_answer).map(r => r.reading),
                    meaningDelta: e.meaningDelta,
                    readingDelta: e.readingDelta,
                };
            }).filter(Boolean);

            items.sort((a, b) =>
                totalMistakes(b) - totalMistakes(a) ||
                a.characters.localeCompare(b.characters)
            );

            const embed = base(`📝 Mistakes — Past 7 Days (${items.length})`)
                .setDescription('Review items with incorrect-answer counts that increased during the past week. Answers are hidden in spoilers.');

            for (const field of listFields(items)) embed.addFields(field);

            return interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error('[mistakes]', err);
            return interaction.editReply({
                embeds: [error('WaniKani Error', 'Could not fetch your recent mistakes.')],
            });
        }
    },
};

function formatMistakeLine(it) {
    const meaning = it.meanings.length ? it.meanings.join(', ') : '—';
    const reading = it.readings.length ? it.readings.join(', ') : null;
    const answer = reading ? `${reading} · ${meaning}` : meaning;
    return `**${it.characters}** ${mistakeSummary(it)} ||${answer}||`;
}

function mistakeSummary(it) {
    const parts = [];
    if (it.meaningDelta > 0) parts.push(`meaning +${it.meaningDelta}`);
    if (it.readingDelta > 0) parts.push(`reading +${it.readingDelta}`);
    return `(${parts.join(', ')})`;
}

function totalMistakes(it) {
    return it.meaningDelta + it.readingDelta;
}

function listFields(items) {
    const MAX_ITEM_FIELDS = 24;
    const fields = [];
    let lines = [];
    for (const item of items) {
        const next = formatMistakeLine(item);
        const candidate = [...lines, next].join('\n');
        if (candidate.length > 1024 && lines.length > 0) {
            fields.push({ name: fields.length === 0 ? 'Items' : 'Items continued', value: lines.join('\n'), inline: false });
            if (fields.length >= MAX_ITEM_FIELDS) {
                lines = [];
                break;
            }
            lines = [next];
        } else {
            lines.push(next);
        }
    }
    if (lines.length && fields.length < MAX_ITEM_FIELDS) {
        fields.push({ name: fields.length === 0 ? 'Items' : 'Items continued', value: lines.join('\n'), inline: false });
    }
    const displayed = fields.reduce((acc, f) => acc + f.value.split('\n').length, 0);
    if (displayed < items.length) {
        fields.push({ name: 'More', value: `And ${items.length - displayed} more item${items.length - displayed === 1 ? '' : 's'}.`, inline: false });
    }
    return fields;
}
