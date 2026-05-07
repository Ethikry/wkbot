const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getWaniKaniData, getSrsBreakdown, getLevelProgress } = require('../helpers/wanikaniData');
const { getAccountForDiscordUser } = require('../helpers/userLink');
const { decrypt } = require('../helpers/crypto');
const { base, error, renderMonthlyHeatmap, HEATMAP_LEGEND } = require('../helpers/embeds');
const { recordPoll } = require('../helpers/zerostate');
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
        await db.run(`INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)`, [guildId]);
        await db.run(
            `INSERT OR IGNORE INTO guild_members (guild_id, discord_user_id) VALUES (?, ?)`,
            [guildId, userId]
        );

        await interaction.deferReply();

        try {
            const apiKey = decrypt(account.api_token_encrypted);
            const data = await getWaniKaniData(apiKey);
            const { userData, pendingLessons, dueRightNow, dueNext24Hours } = data;
            const next24Excl = Math.max(0, dueNext24Hours - dueRightNow);

            await recordPoll(userId, guildId, dueRightNow, account.wanikani_user_id).catch(err =>
                console.error('[wkstats recordPoll]', err.message)
            );

            const [srs, levelProgress, snapshots] = await Promise.all([
                getSrsBreakdown(apiKey),
                getLevelProgress(apiKey, userData.level),
                db.all(
                    `SELECT snapshot_date, reviews_completed, lessons_completed FROM daily_snapshots
                     WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date >= date('now', ?)`,
                    [guildId, userId, `-${HEATMAP_DAYS - 1} days`]
                ),
            ]);

            const snapshotsByDate = new Map(snapshots.map(s => [s.snapshot_date, s.reviews_completed]));
            const heatmap = renderMonthlyHeatmap(snapshotsByDate, HEATMAP_DAYS, 6);
            const totalReviews = snapshots.reduce((acc, s) => acc + (s.reviews_completed || 0), 0);
            const totalLessons = snapshots.reduce((acc, s) => acc + (s.lessons_completed || 0), 0);
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
                    {
                        name: '📅 Past 30 Days',
                        value: [
                            heatmap,
                            HEATMAP_LEGEND,
                            `**${totalReviews}** reviews · **${totalLessons}** lessons`,
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
