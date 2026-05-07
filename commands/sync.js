const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { success, error } = require('../helpers/embeds');
const { getAccountForDiscordUser } = require('../helpers/userLink');
const { updateSnapshotsAndStreaks, utcDateStr } = require('../scheduler');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('sync')
        .setDescription('Refresh your review and lesson counts now without waiting for the daily update')
        .setDMPermission(false),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        const account = await getAccountForDiscordUser(userId);
        if (!account?.api_token_encrypted) {
            return interaction.reply({
                embeds: [error('No API Key', 'Set your WaniKani key with `/setup apikey:<token>` first.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        // /sync requires the user to be a registered member of this guild so the
        // FK on daily_snapshots / streaks / queue_history holds.
        await db.run(
            `INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)`,
            [guildId]
        );
        await db.run(
            `INSERT OR IGNORE INTO guild_members (guild_id, discord_user_id) VALUES (?, ?)`,
            [guildId, userId]
        );

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            await updateSnapshotsAndStreaks(guildId, [{
                discord_user_id: userId,
                wanikani_user_id: account.wanikani_user_id,
                api_token_encrypted: account.api_token_encrypted,
            }]);

            const today = utcDateStr();
            const snap = await db.get(
                `SELECT reviews_completed, lessons_completed FROM daily_snapshots
                 WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date = ?`,
                [guildId, userId, today]
            );

            const reviews = snap?.reviews_completed ?? 0;
            const lessons = snap?.lessons_completed ?? 0;

            return interaction.editReply({
                embeds: [success(
                    'Stats Synced',
                    `Past 24 hours: **${reviews}** reviews · **${lessons}** lessons\nLeaderboard, heatmap, and streak are now up to date.`
                )],
            });
        } catch (err) {
            console.error('[sync]', err);
            return interaction.editReply({
                embeds: [error('Sync Failed', 'Could not fetch data from WaniKani. Check that your API key is still valid.')],
            });
        }
    },
};
