const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getWaniKaniData, getSrsBreakdown, getLevelProgress } = require('../helpers/wanikaniData');
const { getAccountForDiscordUser } = require('../helpers/userLink');
const { base, error, renderMonthlyHeatmap } = require('../helpers/embeds');
const { recordPoll } = require('../helpers/zerostate');
const { DEFAULT_TIME_ZONE, addDaysToDateKey, botDateKey } = require('../helpers/botTime');
const { getEffectiveUserTimeZone } = require('../helpers/tzInfer');
const { awaitInteractionStateRefresh } = require('../helpers/interactionState');
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
        const username = interaction.member?.displayName ?? interaction.user.displayName;

        const account = await getAccountForDiscordUser(userId);
        if (!account?.api_token_encrypted) {
            return interaction.reply({
                embeds: [error('No API Key', 'Set your WaniKani key with `/setup apikey:<token>` first.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        // Make sure /wkstats works as the user's first interaction in a server.
        await db.run(
            `INSERT OR IGNORE INTO guild_settings (guild_id, timezone) VALUES (?, ?)`,
            [guildId, DEFAULT_TIME_ZONE]
        );
        await db.run(
            `INSERT OR IGNORE INTO guild_members (guild_id, discord_user_id) VALUES (?, ?)`,
            [guildId, userId]
        );

        await interaction.deferReply();

        try {
            await awaitInteractionStateRefresh(interaction, 'wkstats');
            const settings = await db.get(`SELECT timezone FROM guild_settings WHERE guild_id = ?`, [guildId]);
            const { timeZone } = await getEffectiveUserTimeZone(userId, settings?.timezone);
            const today = botDateKey(new Date(), timeZone);
            const heatmapStart = addDaysToDateKey(today, -(HEATMAP_DAYS - 1));
            const data = await getWaniKaniData(account);
            const { userData, pendingLessons, dueRightNow, dueNext24Hours } = data;
            const next24Excl = Math.max(0, dueNext24Hours - dueRightNow);

            await recordPoll(userId, guildId, dueRightNow, account.wanikani_user_id).catch(err =>
                console.error('[wkstats recordPoll]', err)
            );

            const [srs, levelProgress, snapshots] = await Promise.all([
                getSrsBreakdown(account),
                getLevelProgress(account, userData.level),
                db.all(
                    `SELECT snapshot_date, reviews_completed, lessons_completed FROM daily_snapshots
                     WHERE guild_id = ? AND discord_user_id = ?
                       AND snapshot_date >= ? AND snapshot_date <= ?`,
                    [guildId, userId, heatmapStart, today]
                ),
            ]);

            const snapshotsByDate = new Map(snapshots.map(s => [s.snapshot_date, s.reviews_completed]));
            const heatmap = renderMonthlyHeatmap(snapshotsByDate, HEATMAP_DAYS, 6, timeZone);
            const totalReviews = snapshots.reduce((acc, s) => acc + (s.reviews_completed || 0), 0);
            const totalLessons = snapshots.reduce((acc, s) => acc + (s.lessons_completed || 0), 0);
            const levelProgressLine = formatLevelProgress(userData.level, levelProgress);

            const embed = base(`📊 ${username}'s WaniKani Stats`)
                .setURL('https://www.wanikani.com/dashboard')
                .addFields(
                    { name: 'Level', value: `**${userData.level}**`, inline: true },
                    { name: 'Lessons Pending', value: `${pendingLessons}`, inline: true },
                    { name: 'Reviews Due', value: `**${dueRightNow}** now · +${next24Excl} next 24h`, inline: true },
                    { name: '🔓 Level Progress', value: levelProgressLine, inline: false },
                    {
                        name: '📚 SRS',
                        value:
                            `🌱 Apprentice **${srs.apprentice}** · 🌿 Guru **${srs.guru}** · 🌳 Master **${srs.master}**\n` +
                            `✨ Enlightened **${srs.enlightened}** · 🔥 Burned **${srs.burned}**`,
                        inline: false,
                    },
                    {
                        name: '📅 30 Day Heatmap',
                        value: [
                            heatmap,
                            '0 ⬛🟦🟩🟨🟧🟥 200+',
                            `**${totalReviews}** reviews · **${totalLessons}** lessons completed in the last 30 days`,
                        ].join('\n'),
                        inline: false,
                    },
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
    if (level >= 60) return '🏆 Max level reached — congratulations!';
    const k = progress.kanji;
    const r = progress.radicals;
    const lines = [];

    if (k.total > 0) {
        const ready = k.passed >= k.threshold;
        lines.push(
            `Kanji at Guru+: ${progressBar(k.passed, k.threshold)} **${k.passed}/${k.threshold}** (${k.percent}%)` +
            (ready ? ' — ready to level up! 🎉' : ` — ${k.remaining} to go`)
        );
    } else {
        lines.push('Kanji at Guru+: *(none unlocked yet at this level)*');
    }

    // Radicals don't gate level-up directly (only kanji 90% does), but they
    // indirectly gate kanji unlocks. Hide the line once all radicals on this
    // level are Guru+ — at that point they no longer affect level-up.
    if (r.total > 0 && r.passed < r.total) {
        lines.push(`Radicals at Guru+: **${r.passed}/${r.total}** (${r.percent}%)`);
    }

    return lines.join('\n');
}

function progressBar(value, goal, width = 12) {
    const ratio = goal > 0 ? Math.min(1, value / goal) : 0;
    const filled = Math.round(ratio * width);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}
