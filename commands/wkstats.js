const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getWaniKaniData, getSrsBreakdown } = require('../helpers/wanikaniData');
const { decrypt } = require('../helpers/crypto');
const { base, error } = require('../helpers/embeds');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wkstats')
        .setDescription('Show your WaniKani statistics')
        .setDMPermission(false),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        const username = interaction.member?.nickname || interaction.user.username;

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
            const [data, srs] = await Promise.all([
                getWaniKaniData(apiKey),
                getSrsBreakdown(apiKey),
            ]);

            const { userData, pendingLessons, dueRightNow, dueNext24Hours } = data;
            const next24Excl = Math.max(0, dueNext24Hours - dueRightNow);

            const embed = base(`📊 ${username}'s WaniKani Stats`)
                .setURL('https://www.wanikani.com/dashboard')
                .addFields(
                    { name: 'Level', value: `**${userData.level}**`, inline: true },
                    { name: 'Lessons Pending', value: `${pendingLessons}`, inline: true },
                    { name: 'Reviews Due Now', value: `${dueRightNow}`, inline: true },
                    { name: 'Coming in Next 24h', value: `${next24Excl}`, inline: true },
                    { name: 'Max Level Granted', value: `${userData.subscription?.max_level_granted ?? 'N/A'}`, inline: true },
                    { name: '​', value: '**SRS Breakdown**', inline: false },
                    { name: '🌱 Apprentice', value: `${srs.apprentice}`, inline: true },
                    { name: '🌿 Guru', value: `${srs.guru}`, inline: true },
                    { name: '🌳 Master', value: `${srs.master}`, inline: true },
                    { name: '✨ Enlightened', value: `${srs.enlightened}`, inline: true },
                    { name: '🔥 Burned', value: `${srs.burned}`, inline: true },
                );

            if (userData.current_vacation_started_at) {
                embed.setDescription('🏖️ Currently in vacation mode');
            }

            return interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error('[wkstats]', err);
            return interaction.editReply({
                embeds: [error('WaniKani API Error', 'Could not fetch your stats. Make sure your API key is still valid.')],
            });
        }
    },
};
