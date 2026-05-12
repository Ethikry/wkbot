const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { base, error } = require('../helpers/embeds');
const { awaitInteractionStateRefresh } = require('../helpers/interactionState');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('streak')
        .setDescription('Show your current review streak')
        .setDMPermission(false),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await awaitInteractionStateRefresh(interaction, 'streak');

        const row = await db.get(
            `SELECT current_streak, longest_streak, last_review_date FROM streaks WHERE guild_id = ? AND discord_user_id = ?`,
            [interaction.guild.id, interaction.user.id]
        );

        if (!row) {
            return interaction.editReply({
                embeds: [error(
                    'No Streak Yet',
                    'Complete some reviews on WaniKani — your streak starts being tracked once the bot sees activity.'
                )],
            });
        }

        const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
        const embed = base('🔥 Your Review Streak')
            .addFields(
                { name: 'Current', value: days(row.current_streak), inline: true },
                { name: 'Longest', value: days(row.longest_streak), inline: true },
                { name: 'Last Active', value: row.last_review_date ?? 'Never', inline: true },
            );

        return interaction.editReply({ embeds: [embed] });
    },
};
