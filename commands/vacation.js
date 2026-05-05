const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { success, error } = require('../helpers/embeds');
const { decrypt } = require('../helpers/crypto');
const { wkFetch } = require('../helpers/wanikaniData');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vacation')
        .setDescription('Sync your daily-ping setting with your WaniKani vacation status')
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
                embeds: [error('No API Key', 'Set your key with `/setup` first.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const userJson = await wkFetch('/user', decrypt(row.api_key));
            const onVacation = !!userJson.data.current_vacation_started_at;
            const newPing = onVacation ? 0 : 1;
            await db.run(
                `UPDATE apikeys SET ping_enabled = ? WHERE user_id = ? AND guild_id = ?`,
                [newPing, userId, guildId]
            );
            return interaction.editReply({
                embeds: [success(
                    'Vacation Synced',
                    onVacation
                        ? "🏖️ You're on vacation — daily pings disabled until you return."
                        : '✅ Not on vacation — daily pings enabled.'
                )],
            });
        } catch (err) {
            console.error('[vacation]', err);
            return interaction.editReply({
                embeds: [error('WaniKani Error', 'Could not check your vacation status.')],
            });
        }
    },
};
