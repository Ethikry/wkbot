const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isApiKeyFormatValid } = require('../helpers/apikeyTest');
const { encrypt } = require('../helpers/crypto');
const { success, error, base } = require('../helpers/embeds');
const { DEFAULT_TIME_ZONE } = require('../helpers/botTime');
const { recordPoll } = require('../helpers/zerostate');
const wkSync = require('../helpers/wkSync');
const { ensureReviewStatsSynced } = require('../helpers/wanikaniData');
const { writeReviewStatSnapshots } = require('../helpers/reviewStatSnapshot');
const { parseSleepHour, formatSleepHours } = require('../helpers/sleepHours');
const { botDateKey, addDaysToDateKey, resolveTimeZone } = require('../helpers/botTime');
const db = require('../db');

const MISTAKE_WINDOW_DAYS = 7;

const WK_REVISION = '20170710';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Link your WaniKani account and set personal (cross-server) preferences')
        .setDMPermission(false)
        .addStringOption(opt =>
            opt.setName('apikey')
                .setDescription('Your WaniKani read-only API token')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('reviews_dm')
                .setDescription('DM me when new reviews unlock')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('streak')
                .setDescription('DM me before my review streak breaks')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('shame')
                .setDescription('Allow shame DMs when you fall short (channel-post shame is configured per server via /guild_setup)')
                .setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('sleep_start')
                .setDescription('Suppress reminder DMs starting at this local hour (0-23). Set with sleep_end to enable.')
                .setMinValue(0)
                .setMaxValue(23)
                .setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('sleep_end')
                .setDescription('Resume reminder DMs at this local hour (0-23). Set with sleep_start to enable.')
                .setMinValue(0)
                .setMaxValue(23)
                .setRequired(false)
        ),

    async execute(interaction) {
        const apiKey = interaction.options.getString('apikey');
        const reviewsDmOpt = interaction.options.getBoolean('reviews_dm');
        const streakOpt = interaction.options.getBoolean('streak');
        const shameOpt = interaction.options.getBoolean('shame');
        const sleepStartOpt = interaction.options.getInteger('sleep_start');
        const sleepEndOpt = interaction.options.getInteger('sleep_end');
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

        const existingUser = await db.get(
            `SELECT reviews_dm_enabled, streak_reminder_enabled, shame_enabled,
                    sleep_start_hour, sleep_end_hour
             FROM user_reminder_settings
             WHERE discord_user_id = ?`,
            [discordUserId]
        );

        const reviewsDm = reviewsDmOpt === null
            ? (existingUser?.reviews_dm_enabled ?? 1)
            : (reviewsDmOpt ? 1 : 0);
        const streak = streakOpt === null
            ? (existingUser?.streak_reminder_enabled ?? 1)
            : (streakOpt ? 1 : 0);
        const shame = shameOpt === null
            ? (existingUser?.shame_enabled ?? 0)
            : (shameOpt ? 1 : 0);
        const sleepStart = sleepStartOpt === null
            ? (existingUser?.sleep_start_hour ?? null)
            : parseSleepHour(sleepStartOpt, 'sleep_start');
        const sleepEnd = sleepEndOpt === null
            ? (existingUser?.sleep_end_hour ?? null)
            : parseSleepHour(sleepEndOpt, 'sleep_end');

        await db.run(
            `INSERT INTO user_reminder_settings
                (discord_user_id, reviews_dm_enabled, streak_reminder_enabled, shame_enabled,
                 sleep_start_hour, sleep_end_hour)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(discord_user_id) DO UPDATE SET
                reviews_dm_enabled = excluded.reviews_dm_enabled,
                streak_reminder_enabled = excluded.streak_reminder_enabled,
                shame_enabled = excluded.shame_enabled,
                sleep_start_hour = excluded.sleep_start_hour,
                sleep_end_hour = excluded.sleep_end_hour,
                updated_at = CURRENT_TIMESTAMP`,
            [discordUserId, reviewsDm, streak, shame, sleepStart, sleepEnd]
        );

        if (apiKey || !existingAccount) {
            return interaction.editReply({
                embeds: [success(
                    'Setup Complete',
                    [
                        wkUser ? `Linked to WaniKani user **${wkUser.username}** (level ${wkUser.level}).` : 'Account linked.',
                        `Reviews-available DM: **${reviewsDm ? 'enabled' : 'disabled'}**.`,
                        `Streak risk DM: **${streak ? 'enabled' : 'disabled'}**.`,
                        `Shame DMs: **${shame ? 'enabled' : 'disabled'}**.`,
                        `Sleep hours: **${formatSleepHours(sleepStart, sleepEnd)}**.`,
                        '',
                        'Server-specific options (channel @mention, queue-clear / burn / level-up announcements, channel shame) live under `/guild_setup`.',
                    ].join('\n')
                )],
            });
        }

        const lines = [];
        if (reviewsDmOpt !== null) lines.push(`Reviews-available DM: **${reviewsDm ? 'enabled' : 'disabled'}**.`);
        if (streakOpt !== null) lines.push(`Streak risk DM: **${streak ? 'enabled' : 'disabled'}**.`);
        if (shameOpt !== null) lines.push(`Shame DMs: **${shame ? 'enabled' : 'disabled'}**.`);
        if (sleepStartOpt !== null || sleepEndOpt !== null) {
            lines.push(`Sleep hours: **${formatSleepHours(sleepStart, sleepEnd)}**.`);
        }

        if (lines.length === 0) {
            return interaction.editReply({ embeds: [showUserSettings({ reviewsDm, streak, shame, sleepStart, sleepEnd })] });
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

function showUserSettings({ reviewsDm, streak, shame, sleepStart, sleepEnd }) {
    return base('⚙️ Your Settings').addFields(
        { name: 'Reviews-available DM', value: reviewsDm ? 'enabled' : 'disabled', inline: true },
        { name: 'Streak risk DM', value: streak ? 'enabled' : 'disabled', inline: true },
        { name: 'Shame DMs', value: shame ? 'enabled' : 'disabled', inline: true },
        { name: 'Sleep hours', value: formatSleepHours(sleepStart, sleepEnd), inline: true },
        {
            name: 'Per-server options',
            value: 'Run `/guild_setup` in a server to configure @mentions, queue-clear / burn / level-up announcements, and channel shame.',
            inline: false,
        },
    );
}
