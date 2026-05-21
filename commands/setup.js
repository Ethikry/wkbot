const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isApiKeyFormatValid } = require('../helpers/apikeyTest');
const { encrypt } = require('../helpers/crypto');
const { success, error, base } = require('../helpers/embeds');
const { DEFAULT_TIME_ZONE } = require('../helpers/botTime');
const { recordPoll } = require('../helpers/zerostate');
const wkSync = require('../helpers/wkSync');
const { ensureReviewStatsSynced } = require('../helpers/wanikaniData');
const { writeReviewStatSnapshots } = require('../helpers/reviewStatSnapshot');
const { botDateKey, addDaysToDateKey, resolveTimeZone } = require('../helpers/botTime');
const db = require('../db');

const MISTAKE_WINDOW_DAYS = 7;

const WK_REVISION = '20170710';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Link your WaniKani account and set personal preferences')
        .setDMPermission(false)
        .addStringOption(opt =>
            opt.setName('apikey')
                .setDescription('Your WaniKani read-only API token')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('ping')
                .setDescription('DM me when new reviews unlock')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('shame')
                .setDescription('Show shame messages alongside your name in daily/weekly posts when you fall short')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('cleared')
                .setDescription('Announce in channel when you clear your review queue (requires server to have this enabled)')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('streak')
                .setDescription('DM me before my review streak breaks')
                .setRequired(false)
        ),

    async execute(interaction) {
        const apiKey = interaction.options.getString('apikey');
        const pingOpt = interaction.options.getBoolean('ping');
        const shameOpt = interaction.options.getBoolean('shame');
        const clearedOpt = interaction.options.getBoolean('cleared');
        const streakOpt = interaction.options.getBoolean('streak');
        const discordUserId = interaction.user.id;
        const guildId = interaction.guild.id;
        const displayName = interaction.member?.displayName ?? interaction.user.username;
        const globalName = interaction.user.globalName ?? null;

        if (apiKey && !isApiKeyFormatValid(apiKey)) {
            return interaction.reply({
                embeds: [error(
                    'Invalid API Key Format',
                    "That doesn't look like a WaniKani API token. It should be a UUID, e.g. `a1b2c3d4-1234-1234-1234-123456789abc`. Generate one at https://www.wanikani.com/settings/personal_access_tokens"
                )],
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let wkUser = null;
        if (apiKey) {
            try {
                wkUser = await fetchWaniKaniUser(apiKey);
            } catch (err) {
                return interaction.editReply({
                    embeds: [error('Invalid API Key', 'WaniKani rejected that token. Make sure it is a current, valid token.')],
                });
            }
        }

        await upsertDiscordUser(discordUserId, displayName, globalName);
        await upsertGuildSettings(guildId);
        await upsertGuildMember(guildId, discordUserId);

        const existingAccount = await db.get(
            `SELECT wanikani_user_id FROM wanikani_accounts WHERE discord_user_id = ?`,
            [discordUserId]
        );

        if (apiKey) {
            await upsertWanikaniAccount(discordUserId, apiKey, wkUser);
            // Seed wk_summary_cache and a queue_history bootstrap row so the
            // cleared-queue detector has a "before" sample if the user clears
            // before the first 5-minute summary refresh.
            await bootstrapSummary(discordUserId, guildId).catch(err =>
                console.warn(`[setup/bootstrapSummary] ${discordUserId}:`, err)
            );
        } else if (!existingAccount) {
            return interaction.editReply({
                embeds: [error(
                    'API Key Required',
                    "You haven't linked a WaniKani account yet. Provide one with `/setup apikey:<token>`."
                )],
            });
        }

        const existingReminders = await db.get(
            `SELECT reviews_ping_enabled, shame_enabled, cleared_enabled, streak_reminder_enabled
             FROM reminder_settings
             WHERE guild_id = ? AND discord_user_id = ?`,
            [guildId, discordUserId]
        );

        const ping = pingOpt === null
            ? (existingReminders?.reviews_ping_enabled ?? 1)
            : (pingOpt ? 1 : 0);
        const shame = shameOpt === null
            ? (existingReminders?.shame_enabled ?? 0)
            : (shameOpt ? 1 : 0);
        const cleared = clearedOpt === null
            ? (existingReminders?.cleared_enabled ?? 1)
            : (clearedOpt ? 1 : 0);
        const streak = streakOpt === null
            ? (existingReminders?.streak_reminder_enabled ?? 1)
            : (streakOpt ? 1 : 0);

        await db.run(
            `INSERT INTO reminder_settings
                (guild_id, discord_user_id, reviews_ping_enabled, shame_enabled, cleared_enabled, streak_reminder_enabled)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
                reviews_ping_enabled = excluded.reviews_ping_enabled,
                shame_enabled = excluded.shame_enabled,
                cleared_enabled = excluded.cleared_enabled,
                streak_reminder_enabled = excluded.streak_reminder_enabled,
                updated_at = CURRENT_TIMESTAMP`,
            [guildId, discordUserId, ping, shame, cleared, streak]
        );

        if (apiKey || !existingAccount) {
            return interaction.editReply({
                embeds: [success(
                    'Setup Complete',
                    [
                        wkUser ? `Linked to WaniKani user **${wkUser.username}** (level ${wkUser.level}).` : 'Account linked.',
                        `Reviews-available DM: **${ping ? 'enabled' : 'disabled'}**.`,
                        `Shame messages: **${shame ? 'enabled' : 'disabled'}**.`,
                        `Queue-cleared announcements: **${cleared ? 'enabled' : 'disabled'}**.`,
                        `Streak risk DM: **${streak ? 'enabled' : 'disabled'}**.`,
                    ].join('\n')
                )],
            });
        }

        const lines = [];
        if (pingOpt !== null) lines.push(`Reviews-available DM: **${ping ? 'enabled' : 'disabled'}**.`);
        if (shameOpt !== null) lines.push(`Shame messages: **${shame ? 'enabled' : 'disabled'}**.`);
        if (clearedOpt !== null) lines.push(`Queue-cleared announcements: **${cleared ? 'enabled' : 'disabled'}**.`);
        if (streakOpt !== null) lines.push(`Streak risk DM: **${streak ? 'enabled' : 'disabled'}**.`);

        if (lines.length === 0) {
            return interaction.editReply({ embeds: [showUserSettings({ ping, shame, cleared, streak })] });
        }
        return interaction.editReply({
            embeds: [success('Settings Updated', lines.join('\n'))],
        });
    },
};

async function fetchWaniKaniUser(apiKey) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch('https://api.wanikani.com/v2/user', {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Wanikani-Revision': WK_REVISION,
            },
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = await res.json();
        return body?.data ?? null;
    } finally {
        clearTimeout(timer);
    }
}

async function upsertDiscordUser(discordUserId, displayName, globalName) {
    await db.run(
        `INSERT INTO discord_users (discord_user_id, display_name, global_name)
         VALUES (?, ?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET
            display_name = excluded.display_name,
            global_name = excluded.global_name,
            updated_at = CURRENT_TIMESTAMP`,
        [discordUserId, displayName, globalName]
    );
}

async function upsertGuildSettings(guildId) {
    await db.run(
        `INSERT OR IGNORE INTO guild_settings (guild_id, timezone) VALUES (?, ?)`,
        [guildId, DEFAULT_TIME_ZONE]
    );
}

async function upsertGuildMember(guildId, discordUserId) {
    await db.run(
        `INSERT OR IGNORE INTO guild_members (guild_id, discord_user_id) VALUES (?, ?)`,
        [guildId, discordUserId]
    );
}

async function bootstrapSummary(discordUserId, guildId) {
    const account = await db.get(
        `SELECT wanikani_user_id, api_token_encrypted FROM wanikani_accounts
         WHERE discord_user_id = ?`,
        [discordUserId]
    );
    if (!account) return;
    await wkSync.syncSummary(account);
    const cache = await db.get(
        `SELECT review_count_now FROM wk_summary_cache WHERE wanikani_user_id = ?`,
        [account.wanikani_user_id]
    );
    const dueRightNow = cache?.review_count_now ?? 0;
    await recordPoll(discordUserId, guildId, dueRightNow, account.wanikani_user_id);

    // Seed a backdated review_stat baseline so /mistakes works for this user
    // immediately rather than waiting a week for the snapshot history to
    // accumulate. Backdated key sits just outside the 7-day mistake window so
    // the baseline query (snapshot_date <= cutoff) always finds it.
    try {
        await ensureReviewStatsSynced(account);
        const settings = await db.get(
            `SELECT timezone FROM guild_settings WHERE guild_id = ?`,
            [guildId]
        );
        const tz = resolveTimeZone(settings?.timezone);
        const today = botDateKey(new Date(), tz);
        const baselineKey = addDaysToDateKey(today, -(MISTAKE_WINDOW_DAYS + 1));
        await writeReviewStatSnapshots(account.wanikani_user_id, baselineKey);
        await writeReviewStatSnapshots(account.wanikani_user_id, today);
    } catch (err) {
        console.warn(`[setup/baselineSnapshot] ${discordUserId}:`, err);
    }
}

function tokenHint(token) {
    return `…${token.slice(-4)}`;
}

async function upsertWanikaniAccount(discordUserId, apiKey, wkUser) {
    const wkUserId = String(wkUser.id);
    const subscription = wkUser.subscription ?? {};
    await db.run(
        `INSERT INTO wanikani_accounts (
            wanikani_user_id, discord_user_id, username, profile_url, level,
            started_at, current_vacation_started_at,
            subscription_active, subscription_type, max_level_granted, subscription_period_ends_at,
            api_token_encrypted, api_token_hint, api_revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(wanikani_user_id) DO UPDATE SET
            discord_user_id = excluded.discord_user_id,
            username = excluded.username,
            profile_url = excluded.profile_url,
            level = excluded.level,
            started_at = excluded.started_at,
            current_vacation_started_at = excluded.current_vacation_started_at,
            subscription_active = excluded.subscription_active,
            subscription_type = excluded.subscription_type,
            max_level_granted = excluded.max_level_granted,
            subscription_period_ends_at = excluded.subscription_period_ends_at,
            api_token_encrypted = excluded.api_token_encrypted,
            api_token_hint = excluded.api_token_hint,
            api_revision = excluded.api_revision,
            last_user_sync_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP`,
        [
            wkUserId,
            discordUserId,
            wkUser.username,
            wkUser.profile_url ?? null,
            wkUser.level,
            wkUser.started_at ?? null,
            wkUser.current_vacation_started_at ?? null,
            subscription.active === undefined ? null : (subscription.active ? 1 : 0),
            subscription.type ?? null,
            subscription.max_level_granted ?? null,
            subscription.period_ends_at ?? null,
            encrypt(apiKey),
            tokenHint(apiKey),
            WK_REVISION,
        ]
    );
}

function showUserSettings({ ping, shame, cleared, streak }) {
    return base('⚙️ Your Settings').addFields(
        { name: 'Reviews-available DM', value: ping ? 'enabled' : 'disabled', inline: true },
        { name: 'Shame messages', value: shame ? 'enabled' : 'disabled', inline: true },
        { name: 'Queue-cleared announcements', value: cleared ? 'enabled' : 'disabled', inline: true },
        { name: 'Streak risk DM', value: streak ? 'enabled' : 'disabled', inline: true },
    );
}
