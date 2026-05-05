const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getWaniKaniData, getSrsBreakdown, getLevelProgress } = require('../helpers/wanikaniData');
const { decrypt } = require('../helpers/crypto');
const { base, error, renderMonthlyHeatmap, HEATMAP_LEGEND } = require('../helpers/embeds');
const db = require('../db');

const HEATMAP_DAYS = 30;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wkstats')
        .setDescription('Show your WaniKani statistics')
        .setDMPermission(false),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        const username = interaction.member?.nickname || interaction.user.username;

        const row = await db.get(
            `SELECT api_key FROM apikeys WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId]
        );
        if (!row) {
            return interaction.reply({
                embeds: [error('No API Key', 'Set your WaniKani key with `/setup apikey:<token>` first.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const apiKey = decrypt(row.api_key);
            const data = await getWaniKaniData(apiKey);
            const { userData, pendingLessons, dueRightNow, dueNext24Hours } = data;
            const next24Excl = Math.max(0, dueNext24Hours - dueRightNow);

            const [srs, levelProgress, snapshots] = await Promise.all([
                getSrsBreakdown(apiKey),
                getLevelProgress(apiKey, userData.level),
                db.all(
                    `SELECT date, reviews_completed FROM daily_snapshots
                     WHERE user_id = ? AND guild_id = ? AND date >= date('now', ?)`,
                    [userId, guildId, `-${HEATMAP_DAYS - 1} days`]
                ),
            ]);

            const snapshotsByDate = new Map(snapshots.map(s => [s.date, s.reviews_completed]));
            const heatmap = renderMonthlyHeatmap(snapshotsByDate, HEATMAP_DAYS, 6);
            const levelProgressLine = formatLevelProgress(userData.level, levelProgress);

            const embed = base(`📊 ${username}'s WaniKani Stats`)
                .setURL('https://www.wanikani.com/dashboard')
                .addFields(
                    { name: 'Level', value: `**${userData.level}**`, inline: true },
                    { name: 'Lessons Pending', value: `${pendingLessons}`, inline: true },
                    { name: 'Reviews Due Now', value: `${dueRightNow}`, inline: true },
                    { name: 'Coming in Next 24h', value: `+${next24Excl}`, inline: true },
                    { name: '🔓 Level Progress', value: levelProgressLine, inline: false },
                    { name: '​', value: '**SRS Breakdown**', inline: false },
                    { name: '🌱 Apprentice', value: `${srs.apprentice}`, inline: true },
                    { name: '🌿 Guru', value: `${srs.guru}`, inline: true },
                    { name: '🌳 Master', value: `${srs.master}`, inline: true },
                    { name: '✨ Enlightened', value: `${srs.enlightened}`, inline: true },
                    { name: '🔥 Burned', value: `${srs.burned}`, inline: true },
                    { name: '📅 Past 30 Days', value: `${heatmap}\n${HEATMAP_LEGEND}`, inline: false },
                );

            if (userData.current_vacation_started_at) {
                embed.setDescription('🏖️ Currently in vacation mode');
            }

            return interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error('[wkstats]', err);
            return interaction.editReply({
                embeds: [error('WaniKani API Error', 'Could not fetch your stats. Make sure your API key is still valid.')],
            });
        }
    },
};

function formatLevelProgress(level, progress) {
    const k = progress.kanji;
    const r = progress.radicals;
    const lines = [];

    if (k.total > 0) {
        const ready = k.percent >= progress.threshold;
        lines.push(
            `Kanji passed: **${k.passed}/${k.total}** (${k.percent}%)` +
            (ready ? ' — ready to level up! 🎉' : ` — need ${progress.threshold}%`)
        );
    } else {
        lines.push('Kanji passed: *(none unlocked yet at this level)*');
    }

    if (r.total > 0) {
        lines.push(`Radicals passed: **${r.passed}/${r.total}** (${r.percent}%)`);
    }

    return lines.join('\n');
}
