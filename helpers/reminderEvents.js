const db = require('../db');

// Writes a row to reminder_events. The FK requires (guild_id, discord_user_id)
// to exist in guild_members, so DM-style events (which aren't guild-scoped per se)
// log against a representative guild — by default the user's first guild_member row.
async function logReminderEvent(opts) {
    const {
        guildId,
        discordUserId,
        wanikaniUserId,
        reminderType,
        deliveryTarget,
        status = 'sent',
        reviewCount = null,
        lessonCount = null,
        channelId = null,
        messageId = null,
        error = null,
        scheduledFor = null,
    } = opts;

    let resolvedGuildId = guildId;
    if (!resolvedGuildId) {
        const row = await db.get(
            `SELECT guild_id FROM guild_members WHERE discord_user_id = ? LIMIT 1`,
            [discordUserId]
        );
        resolvedGuildId = row?.guild_id;
        if (!resolvedGuildId) return; // user has no guild memberships; skip
    }

    await db.run(
        `INSERT INTO reminder_events (
            guild_id, discord_user_id, wanikani_user_id, reminder_type,
            review_count, lesson_count,
            scheduled_for, sent_at, delivery_target,
            discord_channel_id, discord_message_id,
            status, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            resolvedGuildId, discordUserId, wanikaniUserId, reminderType,
            reviewCount, lessonCount,
            scheduledFor,
            status === 'sent' ? new Date().toISOString() : null,
            deliveryTarget,
            channelId, messageId,
            status, error,
        ]
    );
}

module.exports = { logReminderEvent };
