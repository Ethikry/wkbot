const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { fetchAllPages, getSubjectsByIds } = require('../helpers/wanikaniData');
const { getAccountForDiscordUser } = require('../helpers/userLink');
const { decrypt } = require('../helpers/crypto');
const { base, error } = require('../helpers/embeds');
const db = require('../db');

function srsGroup(stage) {
    if (stage >= 1 && stage <= 4) return 'apprentice';
    if (stage === 5 || stage === 6) return 'guru';
    if (stage === 7) return 'master';
    if (stage === 8) return 'enlightened';
    if (stage === 9) return 'burned';
    return 'other';
}

const GROUP_ORDER = ['burned', 'enlightened', 'master', 'guru', 'apprentice', 'other'];
const GROUP_HEADER = {
    burned: '🔥 Burned',
    enlightened: '✨ Enlightened',
    master: '🌳 Master',
    guru: '🌿 Guru',
    apprentice: '🌱 Apprentice',
    other: '❔ Other',
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mistakes')
        .setDescription('Show your WaniKani mistakes from the past week (answers in spoilers)')
        .setDMPermission(false),

    async execute(interaction) {
        const userId = interaction.user.id;

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
            const since = new Date();
            since.setUTCDate(since.getUTCDate() - 7);
            const sinceISO = since.toISOString();

            // Step 1: assignments updated in window with started_at before the window = reviewed items
            const recentAssignments = await fetchAllPages(
                `/assignments?updated_after=${encodeURIComponent(sinceISO)}&started=true`,
                apiKey
            );
            const cutoff = new Date(sinceISO);
            const reviewed = recentAssignments.filter(a =>
                a.data.started_at && new Date(a.data.started_at) < cutoff
            );

            if (reviewed.length === 0) {
                return interaction.editReply({
                    embeds: [base('📭 No Data Yet')
                        .setDescription('No reviews found in the past 7 days. Check back after you\'ve done some reviews!')],
                });
            }

            const subjectIds = [...new Set(reviewed.map(a => a.data.subject_id))];

            // Step 2: current review_statistics for those subjects
            const currentStats = [];
            for (let i = 0; i < subjectIds.length; i += 500) {
                const chunk = subjectIds.slice(i, i + 500);
                const page = await fetchAllPages(
                    `/review_statistics?subject_ids=${chunk.join(',')}`,
                    apiKey
                );
                currentStats.push(...page);
            }

            // Step 3: oldest stored snapshot per subject — used as the pre-window baseline
            const placeholders = subjectIds.map(() => '?').join(',');
            const snapRows = await db.all(
                `SELECT subject_id, meaning_incorrect, reading_incorrect
                 FROM review_stat_snapshots
                 WHERE wanikani_user_id = ? AND subject_id IN (${placeholders})
                 GROUP BY subject_id
                 HAVING snapshot_date = MIN(snapshot_date)`,
                [wanikaniUserId, ...subjectIds]
            );
            const baselineMap = new Map(snapRows.map(r => [r.subject_id, r]));

            // Step 4: diff — items where error counts increased since the baseline
            const srsMap = new Map(reviewed.map(a => [a.data.subject_id, a.data.srs_stage]));
            const errored = currentStats.filter(s => {
                const base = baselineMap.get(s.data.subject_id);
                const prevMeaning = base?.meaning_incorrect ?? 0;
                const prevReading = base?.reading_incorrect ?? 0;
                return (s.data.meaning_incorrect || 0) > prevMeaning ||
                       (s.data.reading_incorrect || 0) > prevReading;
            });

            const noSnapshotData = baselineMap.size === 0;

            if (errored.length === 0) {
                const desc = noSnapshotData
                    ? 'No baseline data yet — snapshots are recorded during the daily summary. Check back tomorrow for accurate 7-day tracking.'
                    : 'You haven\'t missed a single review in the past 7 days. Nice.';
                return interaction.editReply({
                    embeds: [base(noSnapshotData ? '📊 Building Baseline…' : '🎯 No Mistakes!')
                        .setDescription(desc)],
                });
            }

            const subjectIdsErrored = errored.map(s => s.data.subject_id);
            const subjects = await getSubjectsByIds(apiKey, subjectIdsErrored);
            const subjectMap = new Map(subjects.map(s => [s.id, s.data]));

            const items = errored.map(s => {
                const subj = subjectMap.get(s.data.subject_id);
                if (!subj) return null;
                return {
                    subjectId: s.data.subject_id,
                    characters: subj.characters || subj.slug || '?',
                    meanings: (subj.meanings || []).map(m => m.meaning).filter(Boolean),
                    readings: (subj.readings || []).filter(r => r.accepted_answer).map(r => r.reading),
                    srsStage: srsMap.get(s.data.subject_id) ?? 0,
                };
            }).filter(Boolean);

            items.sort((a, b) => b.srsStage - a.srsStage);

            const grouped = new Map();
            for (const it of items) {
                const g = srsGroup(it.srsStage);
                if (!grouped.has(g)) grouped.set(g, []);
                grouped.get(g).push(it);
            }

            const embed = base(`📝 Mistakes — Past 7 Days (${items.length})`)
                .setDescription('Answers hidden in spoilers — click to reveal.');

            for (const groupKey of GROUP_ORDER) {
                const groupItems = grouped.get(groupKey);
                if (!groupItems?.length) continue;
                embed.addFields({
                    name: `${GROUP_HEADER[groupKey]} (${groupItems.length})`,
                    value: clipFieldValue(groupItems.map(formatMistakeLine).join('\n')),
                    inline: false,
                });
            }

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
    return `**${it.characters}** ||${answer}||`;
}

function clipFieldValue(s) {
    const MAX = 1024;
    if (s.length <= MAX) return s;
    const truncated = s.slice(0, MAX - 20);
    const lastNewline = truncated.lastIndexOf('\n');
    return (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) + '\n*…and more*';
}
