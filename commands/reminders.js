const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { base, error } = require('../helpers/embeds');
const db = require('../db');

const TYPE_LABEL = {
    reviews_available: '📚 Reviews available',
    lessons_available: '🎓 Lessons available',
    reviews_cleared:   '🧹 Reviews cleared',
    daily_summary:     '📅 Daily summary',
    shame:             '💢 Shame',
    streak_risk:       '🔥 Streak risk',
};

const STATUS_ICON = {
    sent:    '✅',
    failed:  '⚠️',
    skipped: '⏭️',
    pending: '⏳',
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reminders')
        .setDescription('Show your reminder preferences and recent reminder history')
        .setDMPermission(false),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        const guildSettings = await db.get(
            `SELECT reviews_ping_enabled,
                    shame_enabled, cleared_enabled,
                    burn_announcement_enabled, levelup_announcement_enabled,
                    min_review_count
             FROM reminder_settings
             WHERE guild_id = ? AND discord_user_id = ?`,
            [guildId, userId]
        );

        const userSettings = await db.get(
            `SELECT reviews_dm_enabled, streak_reminder_enabled, shame_enabled
             FROM user_reminder_settings
             WHERE discord_user_id = ?`,
            [userId]
        );

        if (!guildSettings && !userSettings) {
            return interaction.reply({
                embeds: [error('No Settings', 'Run `/setup` to register reminder preferences.')],
                flags: MessageFlags.Ephemeral,
            });
        }
        const settings = guildSettings ?? {};
        const userPrefs = userSettings ?? {};

        const events = await db.all(
            `SELECT reminder_type, delivery_target, status, sent_at, review_count, lesson_count, error
             FROM reminder_events
             WHERE discord_user_id = ?
             ORDER BY reminder_event_id DESC
             LIMIT 10`,
            [userId]
        );

        const embed = base('🔔 Your Reminders')
            .addFields(
                { name: '— Personal (cross-server) —', value: '`/setup` to change', inline: false },
                { name: 'Reviews-available DM', value: (userPrefs.reviews_dm_enabled ?? 1) ? 'on' : 'off', inline: true },
                { name: 'Streak risk DM', value: (userPrefs.streak_reminder_enabled ?? 1) ? 'on' : 'off', inline: true },
                { name: 'Shame DMs', value: (userPrefs.shame_enabled ?? 0) ? 'on' : 'off', inline: true },
                { name: '— This server —', value: '`/guild_setup` to change', inline: false },
                { name: 'Daily/weekly @mention', value: (settings.reviews_ping_enabled ?? 1) ? 'on' : 'off', inline: true },
                { name: 'Queue-cleared announce', value: (settings.cleared_enabled ?? 1) ? 'on' : 'off', inline: true },
                { name: 'Burn announce', value: (settings.burn_announcement_enabled ?? 1) ? 'on' : 'off', inline: true },
                { name: 'Level-up announce', value: (settings.levelup_announcement_enabled ?? 1) ? 'on' : 'off', inline: true },
                { name: 'Channel shame', value: (settings.shame_enabled ?? 0) ? 'on' : 'off', inline: true },
            );

        if (events.length === 0) {
            embed.addFields({ name: 'Recent activity', value: '_No reminders sent yet._' });
        } else {
            const lines = events.map(e => {
                const when = e.sent_at ? e.sent_at.replace('T', ' ').slice(0, 16) : '—';
                const label = TYPE_LABEL[e.reminder_type] ?? e.reminder_type;
                const target = e.delivery_target === 'dm' ? 'DM' : 'channel';
                const icon = STATUS_ICON[e.status] ?? '·';
                const counts = e.review_count !== null
                    ? ` · ${e.review_count} reviews`
                    : (e.lesson_count !== null ? ` · ${e.lesson_count} lessons` : '');
                return `${icon} \`${when}\` ${label} (${target})${counts}`;
            });
            embed.addFields({ name: `Recent activity (${events.length})`, value: lines.join('\n') });
        }

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
