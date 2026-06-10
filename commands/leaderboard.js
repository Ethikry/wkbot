const { SlashCommandBuilder } = require('discord.js');
const { base, error } = require('../helpers/embeds');
const { addDaysToDateKey, botDateKey, resolveTimeZone } = require('../helpers/botTime');
const { buildWeeklyExtras } = require('../helpers/weeklyExtras');
const { awaitInteractionStateRefresh } = require('../helpers/interactionState');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show this week\'s WaniKani leaderboard')
        .setDMPermission(false),

    async execute(interaction) {
        await interaction.deferReply();
        await awaitInteractionStateRefresh(interaction, 'leaderboard');

        const guildId = interaction.guild.id;
        const settings = await db.get(`SELECT timezone FROM guild_settings WHERE guild_id = ?`, [guildId]);
        const timeZone = resolveTimeZone(settings?.timezone);
        const sinceStr = addDaysToDateKey(botDateKey(new Date(), timeZone), -7);

        const rows = await db.all(
            `SELECT discord_user_id,
                    COALESCE(SUM(reviews_completed), 0) AS reviews,
                    COALESCE(SUM(lessons_completed), 0) AS lessons
             FROM daily_snapshots
             WHERE guild_id = ? AND snapshot_date >= ?
             GROUP BY discord_user_id
             HAVING reviews > 0 OR lessons > 0
             ORDER BY reviews DESC, lessons DESC
             LIMIT 10`,
            [guildId, sinceStr]
        );

        if (rows.length === 0) {
            return interaction.editReply({
                embeds: [error('No Data Yet', 'No reviews tracked in the past 7 days. Snapshots are recorded once a day with the daily recap.')],
            });
        }

        const lines = await Promise.all(rows.map(async (r, i) => {
            const member = await interaction.guild.members.fetch(r.discord_user_id).catch(() => null);
            const name = member ? member.displayName : 'Unknown';
            const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
            return `${medal} **${name}** — ${r.reviews} reviews · ${r.lessons} lessons`;
        }));

        const streakRows = await db.all(
            `SELECT discord_user_id, current_streak, longest_streak
             FROM streaks
             WHERE guild_id = ? AND longest_streak > 0
             ORDER BY longest_streak DESC, current_streak DESC, discord_user_id ASC
             LIMIT 3`,
            [guildId]
        );
        const streakLines = await Promise.all(streakRows.map(async (r, i) => {
            const member = await interaction.guild.members.fetch(r.discord_user_id).catch(() => null);
            const name = member ? member.displayName : 'Unknown';
            const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
            const days = n => `${n} day${n === 1 ? '' : 's'}`;
            return `${medal} **${name}** — ${days(r.longest_streak)} (current: ${r.current_streak})`;
        }));

        const extras = await buildWeeklyExtras(guildId, interaction.guild, timeZone);

        const embed = base('🏆 Weekly Leaderboard')
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Past 7 days · WaniKani Bot' });

        if (extras.fields.length) embed.addFields(...extras.fields);
        if (streakLines.length) {
            embed.addFields({ name: '🔥 Longest Streaks', value: streakLines.join('\n'), inline: false });
        }

        return interaction.editReply({ embeds: [embed] });
    },
};
