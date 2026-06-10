const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { success } = require('../helpers/embeds');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('forget')
        .setDescription('Delete all your data stored by this bot in this server')
        .setDMPermission(false),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        // Deleting the guild_members row cascades to streaks, goals, daily_snapshots,
        // queue_history, reminder_settings, reminder_events, and bot_user_state.
        await db.run(
            `DELETE FROM guild_members WHERE guild_id = ? AND discord_user_id = ?`,
            [guildId, userId]
        );

        // If the user has no remaining guild memberships, clean up their global rows too.
        const otherGuilds = await db.get(
            `SELECT 1 FROM guild_members WHERE discord_user_id = ? LIMIT 1`,
            [userId]
        );
        if (!otherGuilds) {
            // Order matters: user_goals references wanikani_accounts; deleting the account
            // would cascade-delete user_goals anyway, but be explicit. long_goals is the
            // legacy pre-v16 table, purged here too for privacy.
            await db.run(`DELETE FROM user_goals WHERE discord_user_id = ?`, [userId]);
            await db.run(`DELETE FROM long_goals WHERE discord_user_id = ?`, [userId]);
            await db.run(`DELETE FROM wanikani_accounts WHERE discord_user_id = ?`, [userId]);
            await db.run(`DELETE FROM discord_users WHERE discord_user_id = ?`, [userId]);
        }

        return interaction.reply({
            embeds: [success(
                'Forgotten',
                otherGuilds
                    ? 'Your data in this server has been deleted. Your WaniKani link is preserved for other servers you share with this bot.'
                    : 'Your stored API key, streak, goals, snapshots, and history have been fully deleted.'
            )],
            flags: MessageFlags.Ephemeral,
        });
    },
};
