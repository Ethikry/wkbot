const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { base, success } = require('../helpers/embeds');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('daily_goal')
        .setDescription('Set or view your daily WaniKani targets (auto-set if /goal is configured)')
        .setDMPermission(false)
        .addIntegerOption(o =>
            o.setName('lessons')
                .setDescription('Daily lesson target')
                .setMinValue(0)
                .setMaxValue(500)
        )
        .addIntegerOption(o =>
            o.setName('reviews')
                .setDescription('Daily review target')
                .setMinValue(0)
                .setMaxValue(2000)
        )
        .addBooleanOption(o =>
            o.setName('all')
                .setDescription('Goal: clear your review queue at least once in any rolling 24h window')
        ),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        const lessons = interaction.options.getInteger('lessons');
        const reviews = interaction.options.getInteger('reviews');
        const all = interaction.options.getBoolean('all');

        if (lessons === null && reviews === null && all === null) {
            const row = await db.get(
                `SELECT daily_lessons, daily_reviews, daily_all FROM goals WHERE user_id = ? AND guild_id = ?`,
                [userId, guildId]
            );
            const embed = base('🎯 Your Daily Goals')
                .addFields(
                    { name: 'Lessons', value: `${row?.daily_lessons ?? 0}`, inline: true },
                    { name: 'Reviews', value: `${row?.daily_reviews ?? 0}`, inline: true },
                    { name: 'Clear queue', value: row?.daily_all ? 'on' : 'off', inline: true },
                );
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        const existing = await db.get(
            `SELECT daily_lessons, daily_reviews, daily_all FROM goals WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId]
        );
        const newLessons = lessons ?? existing?.daily_lessons ?? 0;
        const newReviews = reviews ?? existing?.daily_reviews ?? 0;
        const newAll = all === null ? (existing?.daily_all ?? 0) : (all ? 1 : 0);

        if (existing) {
            await db.run(
                `UPDATE goals SET daily_lessons = ?, daily_reviews = ?, daily_all = ? WHERE user_id = ? AND guild_id = ?`,
                [newLessons, newReviews, newAll, userId, guildId]
            );
        } else {
            await db.run(
                `INSERT INTO goals (user_id, guild_id, daily_lessons, daily_reviews, daily_all) VALUES (?, ?, ?, ?, ?)`,
                [userId, guildId, newLessons, newReviews, newAll]
            );
        }

        return interaction.reply({
            embeds: [success(
                'Goals Updated',
                `Lessons: **${newLessons}** • Reviews: **${newReviews}** • Clear queue: **${newAll ? 'on' : 'off'}**\nProgress will appear in the daily summary.`
            )],
            flags: MessageFlags.Ephemeral,
        });
    },
};
