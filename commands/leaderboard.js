const { SlashCommandBuilder } = require('discord.js');
const { base, error } = require('../helpers/embeds');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show this week\'s WaniKani leaderboard')
        .setDMPermission(false),

    async execute(interaction) {
        await interaction.deferReply();

        const guildId = interaction.guild.id;
        const since = new Date();
        since.setUTCDate(since.getUTCDate() - 7);
        const sinceStr = since.toISOString().slice(0, 10);

        const rows = await db.all(
            `SELECT user_id,
                    COALESCE(SUM(reviews_completed), 0) AS reviews,
                    COALESCE(SUM(lessons_completed), 0) AS lessons
             FROM daily_snapshots
             WHERE guild_id = ? AND date >= ?
             GROUP BY user_id
             HAVING reviews > 0 OR lessons > 0
             ORDER BY reviews DESC, lessons DESC
             LIMIT 10`,
            [guildId, sinceStr]
        );

        if (rows.length === 0) {
            return interaction.editReply({
                embeds: [error('No Data Yet', 'No reviews tracked in the past 7 days. Snapshots are recorded once a day after the daily summary.')],
            });
        }

        const lines = await Promise.all(rows.map(async (r, i) => {
            const member = await interaction.guild.members.fetch(r.user_id).catch(() => null);
            const name = member ? member.displayName : 'Unknown';
            const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
            return `${medal} **${name}** — ${r.reviews} reviews · ${r.lessons} lessons`;
        }));

        const embed = base('🏆 Weekly Leaderboard')
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Past 7 days · WaniKani Bot' });

        return interaction.editReply({ embeds: [embed] });
    },
};
