const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { decrypt } = require('../helpers/crypto');
const { wkFetch, getRandomKanjiAtLevel } = require('../helpers/wanikaniData');
const { base, error } = require('../helpers/embeds');
const db = require('../db');

function stripHtml(s) {
    if (!s) return '';
    return s.replace(/<[^>]+>/g, '');
}

function clip(s, max) {
    if (!s) return '—';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('kanji')
        .setDescription('Show a random kanji from your current WaniKani level')
        .setDMPermission(false)
        .addIntegerOption(o =>
            o.setName('level')
                .setDescription('Override level (1–60)')
                .setMinValue(1)
                .setMaxValue(60)
        ),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        const row = await db.get(
            `SELECT api_key FROM apikeys WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId]
        );
        if (!row) {
            return interaction.reply({
                embeds: [error('No API Key', 'Set your key with `/setup` first.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply();

        try {
            const apiKey = decrypt(row.api_key);
            const overrideLevel = interaction.options.getInteger('level');
            const level = overrideLevel ?? (await wkFetch('/user', apiKey)).data.level;

            const subject = await getRandomKanjiAtLevel(apiKey, level);
            if (!subject) {
                return interaction.editReply({
                    embeds: [error('No Kanji', `Couldn't find any kanji at level ${level}.`)],
                });
            }

            const d = subject.data;
            const meanings = (d.meanings || []).map(m => m.meaning).join(', ') || '—';
            const onyomi = (d.readings || []).filter(r => r.type === 'onyomi').map(r => r.reading).join(', ') || '—';
            const kunyomi = (d.readings || []).filter(r => r.type === 'kunyomi').map(r => r.reading).join(', ') || '—';
            const mnemonic = clip(stripHtml(d.meaning_mnemonic), 1000);

            const embed = base(`漢字 — ${d.characters}`)
                .setURL(d.document_url)
                .setDescription(`Level **${d.level}** kanji`)
                .addFields(
                    { name: 'Meanings', value: meanings, inline: false },
                    { name: "On'yomi", value: onyomi, inline: true },
                    { name: "Kun'yomi", value: kunyomi, inline: true },
                    { name: 'Meaning Mnemonic', value: mnemonic, inline: false },
                );

            return interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error('[kanji]', err);
            return interaction.editReply({
                embeds: [error('WaniKani Error', 'Could not fetch a kanji right now.')],
            });
        }
    },
};
