const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { base, error } = require('../helpers/embeds');
const { awaitInteractionStateRefresh } = require('../helpers/interactionState');
const { MAX_OFFERINGS, OFFERING_COOLDOWN_DAYS } = require('../helpers/streaks');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('streak')
        .setDescription('Show your current study streak and offerings')
        .setDMPermission(false),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await awaitInteractionStateRefresh(interaction, 'streak');

        const row = await db.get(
            `SELECT current_streak, longest_streak, last_review_date, last_streak_date,
                    offerings_available, offering_return_date, frozen_dates
             FROM streaks WHERE guild_id = ? AND discord_user_id = ?`,
            [interaction.guild.id, interaction.user.id]
        );

        if (!row) {
            return interaction.editReply({
                embeds: [error(
                    'No Streak Yet',
                    'Do some lessons or reviews on WaniKani — your streak starts being tracked once the bot sees activity.'
                )],
            });
        }

        const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
        const available = row.offerings_available ?? MAX_OFFERINGS;

        // Ghost turtles stand in for offerings that are still recharging, the
        // same way the WaniKani widget renders a spent offering.
        const tray = '🐢'.repeat(available) + '👻'.repeat(Math.max(0, MAX_OFFERINGS - available));
        const offeringLines = [`${tray} **${available}/${MAX_OFFERINGS}** available`];
        if (row.offering_return_date) {
            offeringLines.push(`Next one returns **${row.offering_return_date}**`);
        }
        offeringLines.push(
            `-# Miss a day and an offering saves the streak. Each one takes ${OFFERING_COOLDOWN_DAYS} days to come back.`
        );

        let frozen = [];
        try {
            frozen = JSON.parse(row.frozen_dates ?? '[]');
        } catch {
            frozen = [];
        }

        const embed = base('🔥 Your Study Streak')
            .addFields(
                { name: 'Current', value: days(row.current_streak), inline: true },
                { name: 'Longest', value: days(row.longest_streak), inline: true },
                { name: 'Last Active', value: row.last_review_date ?? 'Never', inline: true },
                { name: 'Offerings', value: offeringLines.join('\n'), inline: false },
            );

        if (frozen.length > 0) {
            embed.addFields({
                name: '👻 Saved by an offering',
                value: frozen.slice(-MAX_OFFERINGS).join(', '),
                inline: false,
            });
        }

        return interaction.editReply({ embeds: [embed] });
    },
};
