const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { success } = require('../helpers/embeds');
const db = require('../db');

const TABLES = ['apikeys', 'streaks', 'daily_snapshots', 'goals', 'user_state'];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('forget')
        .setDescription('Delete all your data stored by this bot in this server')
        .setDMPermission(false),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        for (const table of TABLES) {
            await db.run(
                `DELETE FROM ${table} WHERE user_id = ? AND guild_id = ?`,
                [userId, guildId]
            );
        }

        return interaction.reply({
            embeds: [success(
                'Forgotten',
                'Your stored API key, streak, goals, daily snapshots, and level history have been deleted from this server.'
            )],
            flags: MessageFlags.Ephemeral,
        });
    },
};
