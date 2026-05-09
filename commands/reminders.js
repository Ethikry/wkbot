const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { base, error } = require('../helpers/embeds');
const db = require('../db');

const TYPE_LABEL = {
    reviews_available: '📚 Reviews available',
    lessons_available: '🎓 Lessons available',
    reviews_cleared:   '🧹 Reviews cleared',
    daily_summary:     '📅 Daily summary',
    shame:             '💢 Shame',
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

        const settings = await db.get(
            `SELECT reviews_ping_enabled, shame_enabled, cleared_enabled,
                    dm_enabled, channel_enabled, min_review_count
             FROM reminder_settings
             WHERE guild_id = ? AND discord_user_id = ?`,
            [guildId, userId]
        );

        if (!settings) {
            return interaction.reply({
                embeds: [error('No Settings', 'Run `/setup` in this server first to register reminder preferences.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        const events = await db.all(
            `SELECT reminder_type, delivery_target, status, sent_at, review_count, lesson_count, error
             FROM reminder_events
             WHERE discord_user_id = ?
             ORDER BY reminder_event_id DESC
             LIMIT 10`,
            [userId]
        );

        const embed = base('🔔 Your Reminders').addFields(
            { name: 'Daily ping', value: settings.reviews_ping_enabled ? 'on' : 'off', inline: true },
            { name: 'Shame messages', value: settings.shame_enabled ? 'on' : 'off', inline: true },
            { name: 'Queue-cleared announce', value: settings.cleared_enabled ? 'on' : 'off', inline: true },
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
