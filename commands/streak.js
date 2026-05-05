const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { base, error } = require('../helpers/embeds');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('streak')
        .setDescription('Show your current review streak')
        .setDMPermission(false),

    async execute(interaction) {
        const row = await db.get(
            `SELECT current_streak, longest_streak, last_review_date FROM streaks WHERE user_id = ? AND guild_id = ?`,
            [interaction.user.id, interaction.guild.id]
        );

        if (!row) {
            return interaction.reply({
                embeds: [error(
                    'No Streak Yet',
                    'Complete some reviews on WaniKani — your streak starts being tracked once the bot sees activity.'
                )],
                flags: MessageFlags.Ephemeral,
            });
        }

        const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
        const embed = base('🔥 Your Review Streak')
            .addFields(
                { name: 'Current', value: days(row.current_streak), inline: true },
                { name: 'Longest', value: days(row.longest_streak), inline: true },
                { name: 'Last Active', value: row.last_review_date ?? 'Never', inline: true },
            );

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
