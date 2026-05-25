const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { success, error } = require('../helpers/embeds');
const { wkFetch } = require('../helpers/wanikaniData');
const { getDecryptedToken } = require('../helpers/userLink');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vacation')
        .setDescription('Sync your daily-ping setting with your WaniKani vacation status')
        .setDMPermission(false),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        const apiKey = await getDecryptedToken(userId);
        if (!apiKey) {
            return interaction.reply({
                embeds: [error('No API Key', 'Set your key with `/setup` first.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const userJson = await wkFetch('/user', apiKey);
            const onVacation = !!userJson.data.current_vacation_started_at;
            const newDm = onVacation ? 0 : 1;
            const newPing = onVacation ? 0 : 1;
            // reviews_dm is user-scoped (DM is cross-guild). reviews_ping is
            // per-guild — toggle just this guild's channel mention.
            await db.run(
                `INSERT INTO user_reminder_settings (discord_user_id, reviews_dm_enabled)
                 VALUES (?, ?)
                 ON CONFLICT(discord_user_id) DO UPDATE SET
                    reviews_dm_enabled = excluded.reviews_dm_enabled,
                    updated_at = CURRENT_TIMESTAMP`,
                [userId, newDm]
            );
            await db.run(
                `INSERT INTO reminder_settings (guild_id, discord_user_id, reviews_ping_enabled)
                 VALUES (?, ?, ?)
                 ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
                    reviews_ping_enabled = excluded.reviews_ping_enabled,
                    updated_at = CURRENT_TIMESTAMP`,
                [guildId, userId, newPing]
            );
            await db.run(
                `UPDATE wanikani_accounts SET current_vacation_started_at = ?, last_user_sync_at = CURRENT_TIMESTAMP
                 WHERE discord_user_id = ?`,
                [userJson.data.current_vacation_started_at ?? null, userId]
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
