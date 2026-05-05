const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { decrypt } = require('../helpers/crypto');
const { getReviewsSince, getSubjectsByIds } = require('../helpers/wanikaniData');
const { base, error } = require('../helpers/embeds');
const db = require('../db');

const SRS_LABELS = {
    1: '🌱 Apprentice I',
    2: '🌱 Apprentice II',
    3: '🌱 Apprentice III',
    4: '🌱 Apprentice IV',
    5: '🌿 Guru I',
    6: '🌿 Guru II',
    7: '🌳 Master',
    8: '✨ Enlightened',
    9: '🔥 Burned',
};

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
        const guildId = interaction.guild.id;

        const row = await db.get(
            `SELECT api_key FROM apikeys WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId]
        );
        if (!row) {
            return interaction.reply({
                embeds: [error('No API Key', 'Set your WaniKani key with `/setup apikey:<token>` first.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const apiKey = decrypt(row.api_key);
            const since = new Date();
            since.setUTCDate(since.getUTCDate() - 7);

            const reviews = await getReviewsSince(apiKey, since.toISOString());
            const errored = reviews.filter(r =>
                (r.data.incorrect_meaning_answers || 0) > 0 ||
                (r.data.incorrect_reading_answers || 0) > 0
            );

            if (errored.length === 0) {
                return interaction.editReply({
                    embeds: [base('🎯 No Mistakes!')
                        .setDescription('You haven\'t missed a single review in the past 7 days. Nice.')],
                });
            }

            const latestPerSubject = new Map();
            for (const r of errored) {
                const id = r.data.subject_id;
                const existing = latestPerSubject.get(id);
                if (!existing || new Date(r.data.created_at) > new Date(existing.created_at)) {
                    latestPerSubject.set(id, r.data);
                }
            }

            const subjectIds = [...latestPerSubject.keys()];
            const subjects = await getSubjectsByIds(apiKey, subjectIds);
            const subjectMap = new Map(subjects.map(s => [s.id, s.data]));

            const items = [];
            for (const [id, reviewData] of latestPerSubject) {
                const subj = subjectMap.get(id);
                if (!subj) continue;
                items.push({
                    subjectId: id,
                    type: subj.object,
                    characters: subj.characters || subj.slug || '?',
                    meanings: (subj.meanings || []).map(m => m.meaning).filter(Boolean),
                    readings: (subj.readings || [])
                        .filter(r => r.accepted_answer)
                        .map(r => r.reading),
                    srsStage: reviewData.ending_srs_stage,
                });
            }

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
                if (!groupItems || groupItems.length === 0) continue;
                const lines = groupItems.map(formatMistakeLine);
                const value = clipFieldValue(lines.join('\n'));
                embed.addFields({
                    name: `${GROUP_HEADER[groupKey]} (${groupItems.length})`,
                    value,
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
