const db = require('../db');

function getSubcommandName(interaction) {
    try {
        const group = interaction.options.getSubcommandGroup(false);
        const subcommand = interaction.options.getSubcommand(false);
        return [group, subcommand].filter(Boolean).join(' ') || null;
    } catch {
        return null;
    }
}

async function recordCommandStart(interaction) {
    const result = await db.run(
        `INSERT INTO command_usage (
            command_name, subcommand_name, guild_id, channel_id, discord_user_id, started_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
            interaction.commandName,
            getSubcommandName(interaction),
            interaction.guildId ?? null,
            interaction.channelId ?? null,
            interaction.user.id,
            new Date().toISOString(),
        ]
    );
    return result.lastID;
}

async function recordCommandFinish(commandUsageId, { status, startedAtMs, error }) {
    if (!commandUsageId) return;
    const finishedAt = new Date().toISOString();
    const durationMs = startedAtMs ? Math.max(0, Date.now() - startedAtMs) : null;
    await db.run(
        `UPDATE command_usage
         SET finished_at = ?, duration_ms = ?, status = ?, error = ?
         WHERE command_usage_id = ?`,
        [
            finishedAt,
            durationMs,
            status,
            error ? String(error.message || error).slice(0, 500) : null,
            commandUsageId,
        ]
    );
}

module.exports = {
    recordCommandStart,
    recordCommandFinish,
};
