const db = require('../db');
const { DEFAULT_TIME_ZONE } = require('./botTime');
const { getAccountForDiscordUser } = require('./userLink');
const {
    updateSnapshotsAndStreaks,
    updateSnapshotsAndStreaksForAccount,
} = require('../scheduler');

const STATE_REFRESH_PROMISE = Symbol.for('wkbot.interactionStateRefresh');
const SKIP_COMMANDS = new Set(['forget']);

const FORCE_FRESH = {
    userMaxAgeMs: 0,
    summaryMaxAgeMs: 0,
    reviewStatsMaxAgeMs: 0,
    assignmentMaxAgeMs: 0,
};

async function upsertDiscordUser(interaction) {
    await db.run(
        `INSERT INTO discord_users (discord_user_id, display_name, global_name)
         VALUES (?, ?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET
            display_name = COALESCE(excluded.display_name, discord_users.display_name),
            global_name = excluded.global_name,
            updated_at = CURRENT_TIMESTAMP`,
        [
            interaction.user.id,
            interaction.member?.displayName ?? interaction.user.displayName ?? interaction.user.username ?? null,
            interaction.user.globalName ?? null,
        ]
    );
}

async function ensureGuildMembership(interaction) {
    if (!interaction.guildId) return;
    await upsertDiscordUser(interaction);
    await db.run(
        `INSERT OR IGNORE INTO guild_settings (guild_id, timezone) VALUES (?, ?)`,
        [interaction.guildId, DEFAULT_TIME_ZONE]
    );
    await db.run(
        `INSERT OR IGNORE INTO guild_members (guild_id, discord_user_id) VALUES (?, ?)`,
        [interaction.guildId, interaction.user.id]
    );
}

async function refreshInteractionState(interaction) {
    if (!interaction?.user?.id || SKIP_COMMANDS.has(interaction.commandName)) return;

    const account = await getAccountForDiscordUser(interaction.user.id);
    if (!account?.api_token_encrypted) return;

    const row = {
        discord_user_id: interaction.user.id,
        wanikani_user_id: account.wanikani_user_id,
        api_token_encrypted: account.api_token_encrypted,
    };

    if (interaction.guildId) {
        await ensureGuildMembership(interaction);
        await updateSnapshotsAndStreaks(interaction.guildId, [row], FORCE_FRESH);
    } else {
        await updateSnapshotsAndStreaksForAccount(row, FORCE_FRESH);
    }
}

function startInteractionStateRefresh(interaction) {
    if (!interaction?.isChatInputCommand?.()) return null;
    if (!interaction[STATE_REFRESH_PROMISE]) {
        interaction[STATE_REFRESH_PROMISE] = refreshInteractionState(interaction);
    }
    return interaction[STATE_REFRESH_PROMISE];
}

async function awaitInteractionStateRefresh(interaction, label = 'command') {
    const promise = interaction?.[STATE_REFRESH_PROMISE] ?? startInteractionStateRefresh(interaction);
    if (!promise) return;
    await promise.catch(err => {
        console.error(`[stateRefresh/${label}]`, err);
    });
}

module.exports = {
    startInteractionStateRefresh,
    awaitInteractionStateRefresh,
};
