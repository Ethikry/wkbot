const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { decrypt } = require('./helpers/crypto');
const {
    getWaniKaniData,
    getReviewsCompletedSince,
    getBurnedCount,
    getResetsSince,
    clearCacheForApiKey,
} = require('./helpers/wanikaniData');
const wkSync = require('./helpers/wkSync');
const { COLOR_PRIMARY, COLOR_ERROR, COLOR_WARN, COLOR_SUCCESS, FOOTER } = require('./helpers/embeds');
const { recordPoll } = require('./helpers/zerostate');
const { pickShameLine } = require('./helpers/shame');
const { generateShameLine } = require('./helpers/anthropic');
const { logReminderEvent } = require('./helpers/reminderEvents');
const { evaluateAchievements } = require('./helpers/achievements');
const { buildWeeklyExtras } = require('./helpers/weeklyExtras');
const {
    DEFAULT_TIME_ZONE,
    addDaysToDateKey,
    botDateKey,
    resolveTimeZone,
    startOfBotDayUtcIso,
} = require('./helpers/botTime');

const guildJobs = new Map();
let summaryRefreshJobHandle = null;
let slowDetectionJobHandle = null;
let dailySyncJobHandle = null;
let paceAlertJobHandle = null;

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;
const START_OF_BOT_DAY = (timeZone) => {
    const resolved = resolveTimeZone(timeZone);
    return startOfBotDayUtcIso(botDateStr(0, resolved), resolved);
};

// Transient burn-count cache. The new schema deliberately doesn't persist this:
// `bot_user_state` is for bot bookkeeping only, and the WK API cache (wk_assignments)
// isn't yet wired up by the scheduler. After a bot restart the first poll silently
// calibrates without firing a celebration — this is a deliberate trade-off vs.
// either reading wk_assignments on every tick or polluting bot_user_state.
const burnedCountByMember = new Map(); // key: `${guildId}::${discordUserId}`

function clearGuildJobs(guildId) {
    const jobs = guildJobs.get(guildId);
    if (jobs) {
        for (const j of jobs) {
            try { j.stop(); } catch { /* ignore */ }
        }
    }
    guildJobs.set(guildId, []);
}

function addJob(guildId, task) {
    if (!guildJobs.has(guildId)) guildJobs.set(guildId, []);
    guildJobs.get(guildId).push(task);
}

function cronExpr(time, dayOfWeek) {
    const [h, m] = time.split(':').map(Number);
    const dow = (dayOfWeek === undefined || dayOfWeek === null) ? '*' : dayOfWeek;
    return `${m} ${h} * * ${dow}`;
}

async function getOrCreateSettings(guildId) {
    await db.run(
        `INSERT OR IGNORE INTO guild_settings (guild_id, timezone) VALUES (?, ?)`,
        [guildId, DEFAULT_TIME_ZONE]
    );
    return db.get(`SELECT * FROM guild_settings WHERE guild_id = ?`, [guildId]);
}

async function resolveOutputChannel(guild, settings) {
    if (settings.announcement_channel_id) {
        const cached = guild.channels.cache.get(settings.announcement_channel_id);
        if (cached?.isTextBased?.()) return cached;
        const fetched = await guild.channels.fetch(settings.announcement_channel_id).catch(() => null);
        if (fetched?.isTextBased?.()) return fetched;
    }
    const fallback = guild.channels.cache.find(
        c => c.name === '日本語上手' && c.isTextBased?.()
    );
    return fallback ?? null;
}

// Returns one row per (guild_member with linked WK account), with reminder flags
// folded in via LEFT JOIN. Defaults match the prior apikeys defaults.
async function getGuildMembers(guildId) {
    return db.all(
        `SELECT
             gm.discord_user_id,
             wa.wanikani_user_id,
             wa.api_token_encrypted,
             COALESCE(rs.reviews_ping_enabled, 1) AS ping_enabled,
             COALESCE(rs.shame_enabled, 0) AS shame_enabled,
             COALESCE(rs.cleared_enabled, 1) AS cleared_enabled
         FROM guild_members gm
         JOIN wanikani_accounts wa ON wa.discord_user_id = gm.discord_user_id
         LEFT JOIN reminder_settings rs
             ON rs.guild_id = gm.guild_id AND rs.discord_user_id = gm.discord_user_id
         WHERE gm.guild_id = ?`,
        [guildId]
    );
}

async function fetchUserSummaries(guild, rows) {
    return Promise.all(rows.map(async row => {
        const member = await guild.members.fetch(row.discord_user_id).catch(() => null);
        const username = member ? member.displayName : 'Unknown';
        try {
            const data = await getWaniKaniData(row);
            await recordPoll(row.discord_user_id, guild.id, data.dueRightNow, row.wanikani_user_id).catch(err =>
                console.error(`[recordPoll] ${row.discord_user_id}@${guild.id}:`, err.message)
            );
            return {
                userId: row.discord_user_id,
                username,
                ping: row.ping_enabled === 1,
                shame: row.shame_enabled === 1,
                onVacation: !!data.userData.current_vacation_started_at,
                level: data.userData.level,
                pendingLessons: data.pendingLessons,
                dueRightNow: data.dueRightNow,
                dueNext24Hours: data.dueNext24Hours,
            };
        } catch (err) {
            console.error(`[scheduler] WK fetch failed for ${row.discord_user_id}:`, err.message);
            return {
                userId: row.discord_user_id,
                username,
                ping: row.ping_enabled === 1,
                shame: row.shame_enabled === 1,
                error: true,
            };
        }
    }));
}

function summaryEmbed(title, description, summaries) {
    const embed = new EmbedBuilder()
        .setColor(COLOR_PRIMARY)
        .setTitle(title)
        .setTimestamp()
        .setFooter(FOOTER);
    if (description) embed.setDescription(description);

    for (const s of summaries) {
        if (s.error) {
            embed.addFields({ name: s.username, value: '⚠️ Error fetching data', inline: false });
        } else if (s.onVacation) {
            embed.addFields({ name: s.username, value: '🏖️ Vacation mode', inline: false });
        } else {
            const next24Excl = Math.max(0, s.dueNext24Hours - s.dueRightNow);
            embed.addFields({
                name: s.username,
                value: `Lvl **${s.level}** • Lessons **${s.pendingLessons}** • Now **${s.dueRightNow}** • Next 24h **+${next24Excl}**`,
                inline: false,
            });
        }
    }
    return embed;
}

async function dailyJob(client, guildId) {
    console.log(`[daily] guild=${guildId}`);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const settings = await getOrCreateSettings(guildId);

    const rows = await getGuildMembers(guildId);
    if (rows.length === 0) return;

    if (settings.daily_summary_enabled) {
        const channel = await resolveOutputChannel(guild, settings);
        if (channel) {
            const summaries = await fetchUserSummaries(guild, rows);
            const embed = summaryEmbed('📅 Daily WaniKani Summary', null, summaries);

            const pingList = summaries.filter(s => s.ping).map(s => `<@${s.userId}>`);
            const sent = await channel.send({
                content: pingList.length ? pingList.join(' ') : undefined,
                embeds: [embed],
            });
            // Log one daily_summary event per pinged member so /reminders history reflects them.
            for (const row of rows) {
                logReminderEvent({
                    guildId,
                    discordUserId: row.discord_user_id,
                    wanikaniUserId: row.wanikani_user_id,
                    reminderType: 'daily_summary',
                    deliveryTarget: 'channel',
                    channelId: channel.id,
                    messageId: sent?.id ?? null,
                    status: 'sent',
                }).catch(e => console.error('[logReminderEvent/daily]', e.message));
            }
        }
    }

    await updateSnapshotsAndStreaks(guildId, rows);
}

async function fetchShameContext(discordUserId) {
    const account = await db.get(
        `SELECT wanikani_user_id, level FROM wanikani_accounts WHERE discord_user_id = ?`,
        [discordUserId]
    );
    if (!account) return { level: null, knownKanji: '' };

    const rows = await db.all(
        `SELECT s.characters
         FROM wk_assignments a
         JOIN wk_subjects s ON s.subject_id = a.subject_id
         WHERE a.wanikani_user_id = ?
           AND s.subject_type = 'kanji'
           AND a.srs_stage >= 5
           AND a.hidden = 0
           AND s.characters IS NOT NULL`,
        [account.wanikani_user_id]
    );
    return {
        level: account.level,
        knownKanji: rows.map(r => r.characters).join(''),
    };
}

async function leaderboardJob(client, guildId) {
    console.log(`[leaderboard] guild=${guildId}`);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const settings = await getOrCreateSettings(guildId);
    const channel = await resolveOutputChannel(guild, settings);
    if (!channel) return;

    const timeZone = resolveTimeZone(settings.timezone);
    const sinceStr = botDateStr(-7, timeZone);

    const rows = await db.all(
        `SELECT
             gm.discord_user_id,
             COALESCE(rs.shame_enabled, 0) AS shame_enabled,
             COALESCE(SUM(ds.reviews_completed), 0) AS reviews,
             COALESCE(SUM(ds.lessons_completed), 0) AS lessons
         FROM guild_members gm
         LEFT JOIN daily_snapshots ds
             ON ds.guild_id = gm.guild_id
             AND ds.discord_user_id = gm.discord_user_id
             AND ds.snapshot_date >= ?
         LEFT JOIN reminder_settings rs
             ON rs.guild_id = gm.guild_id AND rs.discord_user_id = gm.discord_user_id
         WHERE gm.guild_id = ?
         GROUP BY gm.discord_user_id, rs.shame_enabled
         ORDER BY reviews DESC, lessons DESC, gm.discord_user_id ASC`,
        [sinceStr, guildId]
    );

    if (rows.length === 0) return;

    const enriched = await Promise.all(rows.map(async (r, i) => {
        const member = await guild.members.fetch(r.discord_user_id).catch(() => null);
        const name = member ? member.displayName : 'Unknown';
        const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
        return {
            userId: r.discord_user_id,
            name,
            medal,
            reviews: r.reviews,
            lessons: r.lessons,
            shameEnabled: r.shame_enabled === 1,
        };
    }));

    const lines = enriched.map(e => `${e.medal} **${e.name}** — ${e.reviews} reviews · ${e.lessons} lessons`);
    if (enriched.length > 0) {
        lines[0] += ' 👑';
    }

    const streakRows = await db.all(
        `SELECT discord_user_id, current_streak, longest_streak
         FROM streaks
         WHERE guild_id = ? AND longest_streak > 0
         ORDER BY longest_streak DESC, current_streak DESC, discord_user_id ASC
         LIMIT 3`,
        [guildId]
    );
    const streakLines = await Promise.all(streakRows.map(async (r, i) => {
        const member = await guild.members.fetch(r.discord_user_id).catch(() => null);
        const name = member ? member.displayName : 'Unknown';
        const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
        return `${medal} **${name}** — ${r.longest_streak} day${r.longest_streak === 1 ? '' : 's'} (current: ${r.current_streak})`;
    }));

    const shameTargets = enriched.filter(e => e.shameEnabled && e.reviews === 0);
    const shameLines = await Promise.all(shameTargets.map(async e => {
        const user = `<@${e.userId}>`;
        const ctx = await fetchShameContext(e.userId);
        const generated = await generateShameLine({
            user,
            name: e.name,
            lessons: e.lessons,
            medal: e.medal,
            level: ctx.level,
            knownKanji: ctx.knownKanji,
        });
        return generated ?? pickShameLine({ user });
    }));
    const shameBlock = shameLines.length ? '\n\n' + shameLines.join('\n\n') : '';

    const extras = await buildWeeklyExtras(guildId, guild, timeZone);

    const embed = new EmbedBuilder()
        .setColor(COLOR_PRIMARY)
        .setTitle('🏆 Weekly Leaderboard')
        .setDescription(clipDescription(lines.join('\n') + shameBlock))
        .setTimestamp()
        .setFooter({ text: 'Past 7 days · WaniKani Bot' });

    if (extras.fields.length) embed.addFields(...extras.fields);
    if (streakLines.length) {
        embed.addFields({ name: '🔥 Longest Streaks', value: streakLines.join('\n'), inline: false });
    }

    await channel.send({ embeds: [embed] });
}

function clipDescription(s) {
    const MAX = 4000;
    if (s.length <= MAX) return s;
    return s.slice(0, MAX - 20) + '\n*…and more*';
}

async function checkUserResets(apiKey, discordUserId, guildId, wanikaniUserId, lastResetCheckedAt) {
    const since = lastResetCheckedAt
        ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    try {
        const resets = await getResetsSince(apiKey, since);
        const confirmed = resets.filter(r => r.data.confirmed_at);

        if (confirmed.length > 0) {
            const latest = confirmed.sort(
                (a, b) => new Date(b.data.confirmed_at) - new Date(a.data.confirmed_at)
            )[0];
            const targetLevel = latest.data.target_level;
            const resetDate = latest.data.confirmed_at.slice(0, 10);
            console.log(`[reset] ${discordUserId}@${guildId}: reset to level ${targetLevel} on ${resetDate}`);

            await db.run(
                `UPDATE streaks SET current_streak = 0, updated_at = CURRENT_TIMESTAMP
                 WHERE guild_id = ? AND discord_user_id = ?`,
                [guildId, discordUserId]
            );

            await db.run(
                `DELETE FROM daily_snapshots WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date >= ?`,
                [guildId, discordUserId, resetDate]
            );

            clearCacheForApiKey(apiKey);
        }
    } catch (err) {
        console.error(`[reset check] ${discordUserId}@${guildId}:`, err.message);
    }

    await db.run(
        `INSERT INTO bot_user_state (guild_id, discord_user_id, wanikani_user_id, last_reset_checked_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
             last_reset_checked_at = excluded.last_reset_checked_at,
             updated_at = CURRENT_TIMESTAMP`,
        [guildId, discordUserId, wanikaniUserId, now]
    );
}

// ── summary refresh + per-account review timers ─────────────────────────
//
// summaryRefreshJob runs every 5 minutes. It refreshes wk_summary_cache /
// wk_summary_buckets per account (cheap on 304s) and reschedules a per-account
// timer that fires exactly at the next review unlock — so the DM goes out at
// unlock time rather than up-to-15-minutes-late as in the old poll.
//
// Per-guild work (queue_history bookkeeping, cleared-queue announcement) runs
// in the same job because it also depends on the freshly-synced summary.

const reviewTimers = new Map(); // wanikani_user_id -> NodeJS.Timeout

async function summaryRefreshJob(client) {
    const accounts = await db.all(
        `SELECT DISTINCT wanikani_user_id, discord_user_id, api_token_encrypted
         FROM wanikani_accounts`
    );
    for (const account of accounts) {
        try {
            await wkSync.syncSummary(account);
            await scheduleNextReviewTimer(client, account);
            await maybeResetGoalAlertBaseline(account);
            await updateSnapshotsAndStreaksForAccount(account).catch(err =>
                console.error(`[summaryRefresh/snapshots] ${account.wanikani_user_id}:`, err.message)
            );
        } catch (err) {
            console.error(`[summaryRefresh] ${account.wanikani_user_id}:`, err.message);
        }
    }

    for (const guild of client.guilds.cache.values()) {
        try {
            const settings = await getOrCreateSettings(guild.id);
            const channel = await resolveOutputChannel(guild, settings);
            const rows = await getGuildMembers(guild.id);
            for (const row of rows) {
                try {
                    await maybeAnnounceClearedQueue(client, guild, channel, settings, row);
                } catch (err) {
                    console.error(`[summaryRefresh/guild] ${row.discord_user_id}@${guild.id}:`, err.message);
                }
            }
        } catch (err) {
            console.error('[summaryRefresh] guild loop:', err);
        }
    }
}

// Reset the goal-alert baseline whenever the queue is observed empty so that
// the next batch of unlocks correctly registers as "new reviews". Also keeps
// the baseline in sync if the user does reviews without ever fully clearing —
// once the count drops below the prior alert level, we shrink the baseline so
// growth back above it triggers exactly one alert.
async function maybeResetGoalAlertBaseline(account) {
    const cache = await db.get(
        `SELECT review_count_now FROM wk_summary_cache WHERE wanikani_user_id = ?`,
        [account.wanikani_user_id]
    );
    const dueRightNow = cache?.review_count_now ?? 0;
    const goal = await db.get(
        `SELECT last_alerted_review_count FROM long_goals WHERE discord_user_id = ?`,
        [account.discord_user_id]
    );
    if (!goal) return;
    const prev = goal.last_alerted_review_count ?? 0;
    if (dueRightNow < prev) {
        await db.run(
            `UPDATE long_goals SET last_alerted_review_count = ?, updated_at = CURRENT_TIMESTAMP
             WHERE discord_user_id = ?`,
            [dueRightNow, account.discord_user_id]
        );
    }
}

async function maybeAnnounceClearedQueue(client, guild, channel, settings, row) {
    const cache = await db.get(
        `SELECT review_count_now FROM wk_summary_cache WHERE wanikani_user_id = ?`,
        [row.wanikani_user_id]
    );
    const dueRightNow = cache?.review_count_now ?? 0;

    let cleared = false;
    if (
        channel &&
        settings.reviews_cleared_announcements_enabled &&
        row.cleared_enabled !== 0 &&
        dueRightNow === 0
    ) {
        const prev = await db.get(
            `SELECT queue_size FROM queue_history
             WHERE guild_id = ? AND discord_user_id = ?
             ORDER BY recorded_at DESC LIMIT 1`,
            [guild.id, row.discord_user_id]
        );
        if (prev && prev.queue_size > 0) cleared = true;
    }

    await recordPoll(row.discord_user_id, guild.id, dueRightNow, row.wanikani_user_id);

    if (!cleared) return;
    try {
        const reviewsToday = await getReviewsCompletedSince(row, START_OF_BOT_DAY(settings.timezone))
            .catch(() => null);
        const nextBucket = await db.get(
            `SELECT available_at, subject_count FROM wk_summary_buckets
             WHERE wanikani_user_id = ? AND bucket_type = 'review'
               AND datetime(available_at) > datetime('now')
             ORDER BY available_at ASC LIMIT 1`,
            [row.wanikani_user_id]
        );
        const head = reviewsToday !== null
            ? `<@${row.discord_user_id}> just cleared their review queue — **${reviewsToday}** reviews done today!`
            : `<@${row.discord_user_id}> just cleared their review queue — nice!`;
        const description = nextBucket
            ? `${head}\nNext batch: **+${nextBucket.subject_count}** <t:${Math.floor(new Date(nextBucket.available_at).getTime() / 1000)}:R>.`
            : head;
        const embed = new EmbedBuilder()
            .setColor(COLOR_SUCCESS)
            .setTitle('🧹 Reviews cleared!')
            .setDescription(description)
            .setTimestamp()
            .setFooter(FOOTER);
        const sent = await channel.send({ content: `<@${row.discord_user_id}>`, embeds: [embed] });
        await db.run(
            `INSERT INTO bot_user_state (guild_id, discord_user_id, wanikani_user_id, last_reviews_cleared_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
                 last_reviews_cleared_at = excluded.last_reviews_cleared_at,
                 updated_at = CURRENT_TIMESTAMP`,
            [guild.id, row.discord_user_id, row.wanikani_user_id, new Date().toISOString()]
        );
        await logReminderEvent({
            guildId: guild.id,
            discordUserId: row.discord_user_id,
            wanikaniUserId: row.wanikani_user_id,
            reminderType: 'reviews_cleared',
            deliveryTarget: 'channel',
            channelId: channel.id,
            messageId: sent?.id ?? null,
            reviewCount: reviewsToday,
            status: 'sent',
        }).catch(e => console.error('[logReminderEvent]', e.message));
    } catch (err) {
        console.error(`[cleared] ${row.discord_user_id}@${guild.id}:`, err.message);
        await logReminderEvent({
            guildId: guild.id,
            discordUserId: row.discord_user_id,
            wanikaniUserId: row.wanikani_user_id,
            reminderType: 'reviews_cleared',
            deliveryTarget: 'channel',
            channelId: channel?.id ?? null,
            status: 'failed',
            error: err.message,
        }).catch(() => {});
    }
}

async function scheduleNextReviewTimer(client, account) {
    const wkId = account.wanikani_user_id;
    const existing = reviewTimers.get(wkId);
    if (existing) {
        clearTimeout(existing);
        reviewTimers.delete(wkId);
    }

    const next = await db.get(
        `SELECT available_at FROM wk_summary_buckets
         WHERE wanikani_user_id = ?
           AND bucket_type = 'review'
           AND datetime(available_at) > datetime('now')
         ORDER BY available_at ASC LIMIT 1`,
        [wkId]
    );
    if (!next) return;
    let ms = new Date(next.available_at).getTime() - Date.now();
    // Sanity bounds: don't queue absurdly long timers (summaryRefreshJob will
    // re-schedule), and add a tiny buffer so the first sync picks up the unlock.
    if (ms > 24 * 60 * 60 * 1000) return;
    if (ms < 0) ms = 0;
    ms += 30 * 1000;

    const timer = setTimeout(() => {
        reviewTimers.delete(wkId);
        reviewTimerFired(client, account).catch(err =>
            console.error(`[reviewTimer] ${wkId}:`, err.message)
        );
    }, ms);
    reviewTimers.set(wkId, timer);
}

async function reviewTimerFired(client, account) {
    // Refresh /summary so review_count_now reflects the unlock we're firing for.
    try { await wkSync.syncSummary(account); } catch (e) { /* keep going */ }

    const goal = await db.get(
        `SELECT notify_enabled, last_alerted_at, last_alerted_review_count, target_level, deadline
         FROM long_goals WHERE discord_user_id = ?`,
        [account.discord_user_id]
    );
    if (!goal || goal.notify_enabled !== 1) {
        await scheduleNextReviewTimer(client, account);
        return;
    }

    const cache = await db.get(
        `SELECT review_count_now FROM wk_summary_cache WHERE wanikani_user_id = ?`,
        [account.wanikani_user_id]
    );
    const dueRightNow = cache?.review_count_now ?? 0;

    // When the queue empties, reset the alert baseline so the next unlock
    // is correctly recognised as "new reviews".
    if (dueRightNow <= 0) {
        if ((goal.last_alerted_review_count ?? 0) !== 0) {
            await db.run(
                `UPDATE long_goals SET last_alerted_review_count = 0, updated_at = CURRENT_TIMESTAMP
                 WHERE discord_user_id = ?`,
                [account.discord_user_id]
            );
        }
        await scheduleNextReviewTimer(client, account);
        return;
    }

    // Only alert when the count actually grew since the last alert — otherwise
    // a non-empty queue would re-page the user every time a new bucket unlocks.
    const prevCount = goal.last_alerted_review_count ?? 0;
    if (dueRightNow <= prevCount) {
        await scheduleNextReviewTimer(client, account);
        return;
    }

    // Small floor against the 5-minute summaryRefreshJob racing the timer for
    // the same unlock — avoids double-DM during the overlap window.
    if (goal.last_alerted_at) {
        const ageMs = Date.now() - new Date(goal.last_alerted_at).getTime();
        if (ageMs >= 0 && ageMs < 5 * 60 * 1000) {
            await scheduleNextReviewTimer(client, account);
            return;
        }
    }

    const nextBucket = await db.get(
        `SELECT available_at, subject_count FROM wk_summary_buckets
         WHERE wanikani_user_id = ? AND bucket_type = 'review'
           AND datetime(available_at) > datetime('now')
         ORDER BY available_at ASC LIMIT 1`,
        [account.wanikani_user_id]
    );

    const user = await client.users.fetch(account.discord_user_id).catch(() => null);
    if (user) {
        const lines = [
            `You have **${dueRightNow}** review${dueRightNow === 1 ? '' : 's'} ready right now.`,
        ];
        if (nextBucket) {
            const ts = Math.floor(new Date(nextBucket.available_at).getTime() / 1000);
            lines.push(`Next batch: **+${nextBucket.subject_count}** <t:${ts}:R> (<t:${ts}:t>).`);
        }
        lines.push(
            `Goal: level ${goal.target_level}${goal.deadline ? ` by ${goal.deadline}` : ''}.`,
            '',
            'Disable with `/goals` → Configure alerts.'
        );
        const embed = new EmbedBuilder()
            .setColor(COLOR_PRIMARY)
            .setTitle('📚 New reviews available')
            .setDescription(lines.join('\n'))
            .setTimestamp()
            .setFooter(FOOTER);
        try {
            const sent = await user.send({ embeds: [embed] });
            await db.run(
                `UPDATE long_goals
                 SET last_alerted_at = ?, last_alerted_review_count = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE discord_user_id = ?`,
                [new Date().toISOString(), dueRightNow, account.discord_user_id]
            );
            await logReminderEvent({
                discordUserId: account.discord_user_id,
                wanikaniUserId: account.wanikani_user_id,
                reminderType: 'reviews_available',
                deliveryTarget: 'dm',
                reviewCount: dueRightNow,
                messageId: sent?.id ?? null,
                status: 'sent',
            }).catch(e => console.error('[logReminderEvent]', e.message));
        } catch (err) {
            console.warn(`[reviewDM] ${account.discord_user_id}: ${err.message}`);
            await logReminderEvent({
                discordUserId: account.discord_user_id,
                wanikaniUserId: account.wanikani_user_id,
                reminderType: 'reviews_available',
                deliveryTarget: 'dm',
                reviewCount: dueRightNow,
                status: 'failed',
                error: err.message,
            }).catch(() => {});
        }
    }

    await scheduleNextReviewTimer(client, account);
}

// ── slow-loop detection (hourly) ────────────────────────────────────────
// Replaces the old 15-minute pollUsersJob. Level-up / burn / reset detection
// is not time-critical, so it runs once per hour against freshly-synced caches.

async function slowDetectionJob(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            const settings = await getOrCreateSettings(guild.id);
            const channel = await resolveOutputChannel(guild, settings);
            const rows = await getGuildMembers(guild.id);
            for (const row of rows) {
                try {
                    const apiKey = decrypt(row.api_token_encrypted);
                    const accountBefore = await db.get(
                        `SELECT level FROM wanikani_accounts WHERE wanikani_user_id = ?`,
                        [row.wanikani_user_id]
                    );
                    const previousLevel = accountBefore?.level ?? null;

                    await wkSync.syncUser(row);
                    await wkSync.syncAssignments(row);

                    const accountAfter = await db.get(
                        `SELECT level FROM wanikani_accounts WHERE wanikani_user_id = ?`,
                        [row.wanikani_user_id]
                    );
                    const level = accountAfter?.level ?? previousLevel;
                    const burned = settings.burn_celebrations_enabled
                        ? await getBurnedCount(row).catch(() => null)
                        : null;

                    const state = await db.get(
                        `SELECT last_reset_checked_at FROM bot_user_state
                         WHERE guild_id = ? AND discord_user_id = ?`,
                        [guild.id, row.discord_user_id]
                    );
                    await checkUserResets(apiKey, row.discord_user_id, guild.id, row.wanikani_user_id, state?.last_reset_checked_at ?? null);

                    if (
                        channel &&
                        settings.level_up_announcements_enabled &&
                        previousLevel !== null &&
                        level > previousLevel
                    ) {
                        const embed = new EmbedBuilder()
                            .setColor(COLOR_PRIMARY)
                            .setTitle('🎉 Level Up!')
                            .setDescription(`<@${row.discord_user_id}> just reached **level ${level}**!`)
                            .setTimestamp()
                            .setFooter(FOOTER);
                        await channel.send({ content: `<@${row.discord_user_id}>`, embeds: [embed] });
                    }

                    const burnKey = `${guild.id}::${row.discord_user_id}`;
                    const previousBurned = burnedCountByMember.get(burnKey);
                    if (
                        channel &&
                        settings.burn_celebrations_enabled &&
                        burned !== null &&
                        previousBurned !== undefined &&
                        burned > previousBurned
                    ) {
                        const delta = burned - previousBurned;
                        const embed = new EmbedBuilder()
                            .setColor(0xE67E22)
                            .setTitle('🔥 Burned!')
                            .setDescription(`<@${row.discord_user_id}> just burned **${delta}** item${delta === 1 ? '' : 's'} (total burned: **${burned}**)`)
                            .setTimestamp()
                            .setFooter(FOOTER);
                        await channel.send({ embeds: [embed] });
                    }
                    if (burned !== null) burnedCountByMember.set(burnKey, burned);

                    // Achievement check — runs against freshly-synced state.
                    await evaluateAchievements({
                        discordUserId: row.discord_user_id,
                        wanikaniUserId: row.wanikani_user_id,
                    }).catch(e => console.error('[achievements]', e.message));
                } catch (err) {
                    console.error(`[slowDetection] ${row.discord_user_id}@${guild.id}:`, err.message);
                }
            }
        } catch (err) {
            console.error('[slowDetection] guild loop:', err);
        }
    }
}

// ── daily globals + slow-changing per-user data ─────────────────────────

async function dailyGlobalsAndUserSyncJob() {
    // Pick any active user's API key for global resources (subjects, SRS).
    // Subjects are public per WK docs, but the API still requires auth.
    const someAccount = await db.get(
        `SELECT api_token_encrypted FROM wanikani_accounts LIMIT 1`
    );
    if (someAccount) {
        try {
            const { decrypt } = require('./helpers/crypto');
            const apiKey = decrypt(someAccount.api_token_encrypted);
            await wkSync.syncSpacedRepetitionSystems(apiKey).catch(e =>
                console.error('[dailyGlobals] srs:', e.message));
            await wkSync.syncSubjects(apiKey).catch(e =>
                console.error('[dailyGlobals] subjects:', e.message));
        } catch (err) {
            console.error('[dailyGlobals]', err.message);
        }
    }

    const accounts = await db.all(
        `SELECT wanikani_user_id, discord_user_id, api_token_encrypted FROM wanikani_accounts`
    );
    for (const account of accounts) {
        try {
            await wkSync.syncLevelProgressions(account);
            await wkSync.syncReviewStatistics(account);
            await wkSync.syncStudyMaterials(account);
        } catch (err) {
            console.error(`[dailyUserSync] ${account.wanikani_user_id}:`, err.message);
        }
    }
}

// Back-compat: pollUsersJob now just runs the slow-loop detection so any
// callers (tests, manual triggers) keep working.
async function pollUsersJob(client) {
    return slowDetectionJob(client);
}

async function paceAlertJob(client) {
    const goals = await db.all(`SELECT * FROM long_goals WHERE notify_enabled = 1`);

    for (const goal of goals) {
        try {
            if (goal.last_alerted_at) {
                const ageMs = Date.now() - new Date(goal.last_alerted_at).getTime();
                if (ageMs >= 0 && ageMs < TWENTY_HOURS_MS) continue;
            }

            const memberRows = await db.all(
                `SELECT guild_id FROM guild_members WHERE discord_user_id = ?`,
                [goal.discord_user_id]
            );
            if (memberRows.length === 0) continue;

            let lessonsToday = 0;
            for (const m of memberRows) {
                const settings = await getOrCreateSettings(m.guild_id);
                const todayForGuild = botDateStr(0, settings.timezone);
                const snap = await db.get(
                    `SELECT lessons_completed FROM daily_snapshots
                     WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date = ?`,
                    [m.guild_id, goal.discord_user_id, todayForGuild]
                );
                if (snap?.lessons_completed > lessonsToday) {
                    lessonsToday = snap.lessons_completed;
                }
            }

            const target = goal.daily_lessons || 0;
            if (target === 0) continue;
            const ratio = lessonsToday / target;
            if (ratio >= 0.5) continue;

            const user = await client.users.fetch(goal.discord_user_id).catch(() => null);
            if (!user) continue;

            const embed = new EmbedBuilder()
                .setColor(COLOR_WARN)
                .setTitle('⏳ Behind pace today')
                .setDescription([
                    `You've done **${lessonsToday}/${target}** lessons today.`,
                    `Goal: level **${goal.target_level}**${goal.deadline ? ` by **${goal.deadline}**` : ''} (~${(goal.days_per_level ?? 0).toFixed(1)} days/level).`,
                    'Try to log a session today to stay on track.',
                    '',
                    'Disable with `/goals` → Configure alerts.',
                ].join('\n'))
                .setTimestamp()
                .setFooter(FOOTER);

            try {
                await user.send({ embeds: [embed] });
                await db.run(
                    `UPDATE long_goals SET last_alerted_at = ?, updated_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?`,
                    [new Date().toISOString(), goal.discord_user_id]
                );
            } catch (err) {
                console.warn(`[paceDM] ${goal.discord_user_id}: ${err.message}`);
            }
        } catch (err) {
            console.error(`[paceAlert] ${goal.discord_user_id}:`, err.message);
        }
    }
}

// Number of days the per-call lookback covers. Choosing 3 means we backfill
// "today / yesterday / day-before" on every run — enough to recover from a
// missed cron without making the loop expensive.
const SNAPSHOT_LOOKBACK_DAYS = 3;

async function updateSnapshotsAndStreaks(guildId, rows) {
    const settings = await getOrCreateSettings(guildId);
    const timeZone = resolveTimeZone(settings.timezone);
    const {
        ensureUserSynced, ensureReviewStatsSynced,
        getCompletedItemsSince, getSrsBreakdown,
    } = require('./helpers/wanikaniData');

    // Build the list of guild-local days we'll write snapshots for, with the
    // window boundaries needed to bucket assignments updates into them.
    const days = [];
    for (let i = SNAPSHOT_LOOKBACK_DAYS - 1; i >= 0; i--) {
        const dateKey = botDateStr(-i, timeZone);
        const startISO = startOfBotDayUtcIso(dateKey, timeZone);
        const endISO = startOfBotDayUtcIso(botDateStr(-i + 1, timeZone), timeZone);
        days.push({ dateKey, startISO, endISO });
    }
    const earliestStartISO = days[0].startISO;

    for (const row of rows) {
        try {
            await ensureUserSynced(row, 0);
            await ensureReviewStatsSynced(row, 0);

            const acct = await db.get(
                `SELECT level FROM wanikani_accounts WHERE wanikani_user_id = ?`,
                [row.wanikani_user_id]
            );
            const level = acct?.level ?? 0;
            // ensureAssignmentsSynced is invoked inside getCompletedItemsSince
            // with a 4-min staleness floor — back-to-back callers (e.g. the
            // 5-min summaryRefreshJob) won't pile up redundant syncs.
            const items = await getCompletedItemsSince(row, earliestStartISO);
            const srs = await getSrsBreakdown(row);
            const totals = await db.get(
                `SELECT COUNT(*) AS total_assignments,
                        SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END) AS total_started
                 FROM wk_assignments
                 WHERE wanikani_user_id = ? AND hidden = 0`,
                [row.wanikani_user_id]
            );
            const summaryRow = await db.get(
                `SELECT lesson_count, review_count_now, review_count_24h
                 FROM wk_summary_cache WHERE wanikani_user_id = ?`,
                [row.wanikani_user_id]
            );

            // Bucket activity into per-day counts. Reviews = item already
            // started before the day; lessons = item started during the day.
            const byDay = new Map(days.map(d => [d.dateKey, { reviews: 0, lessons: 0 }]));
            for (const it of items) {
                const updatedAt = new Date(it.data_updated_at).getTime();
                const startedAt = new Date(it.started_at).getTime();
                for (const d of days) {
                    const start = new Date(d.startISO).getTime();
                    const end = new Date(d.endISO).getTime();
                    if (updatedAt >= start && updatedAt < end) {
                        const bucket = byDay.get(d.dateKey);
                        if (startedAt < start) bucket.reviews++;
                        else bucket.lessons++;
                        break;
                    }
                }
            }

            for (const d of days) {
                const counts = byDay.get(d.dateKey);
                const isToday = d.dateKey === days[days.length - 1].dateKey;
                await db.run(
                    `INSERT INTO daily_snapshots (
                        guild_id, discord_user_id, wanikani_user_id, snapshot_date,
                        level, reviews_completed, lessons_completed,
                        lessons_available, reviews_available, reviews_24h,
                        apprentice_count, guru_count, master_count, enlightened_count, burned_count,
                        total_assignments, total_subjects_started
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(guild_id, discord_user_id, snapshot_date) DO UPDATE SET
                        level = excluded.level,
                        reviews_completed = CASE WHEN ? THEN excluded.reviews_completed ELSE max(daily_snapshots.reviews_completed, excluded.reviews_completed) END,
                        lessons_completed = CASE WHEN ? THEN excluded.lessons_completed ELSE max(daily_snapshots.lessons_completed, excluded.lessons_completed) END,
                        lessons_available = CASE WHEN ? THEN excluded.lessons_available ELSE daily_snapshots.lessons_available END,
                        reviews_available = CASE WHEN ? THEN excluded.reviews_available ELSE daily_snapshots.reviews_available END,
                        reviews_24h = CASE WHEN ? THEN excluded.reviews_24h ELSE daily_snapshots.reviews_24h END,
                        apprentice_count = excluded.apprentice_count,
                        guru_count = excluded.guru_count,
                        master_count = excluded.master_count,
                        enlightened_count = excluded.enlightened_count,
                        burned_count = excluded.burned_count,
                        total_assignments = excluded.total_assignments,
                        total_subjects_started = excluded.total_subjects_started`,
                    [
                        guildId, row.discord_user_id, row.wanikani_user_id, d.dateKey,
                        level, counts.reviews, counts.lessons,
                        // The "available" counters are point-in-time, so they
                        // only make sense for today's row. For backfilled
                        // rows we keep whatever was there before (CASE above).
                        isToday ? (summaryRow?.lesson_count ?? 0) : 0,
                        isToday ? (summaryRow?.review_count_now ?? 0) : 0,
                        isToday ? (summaryRow?.review_count_24h ?? 0) : 0,
                        srs.apprentice, srs.guru, srs.master, srs.enlightened, srs.burned,
                        totals?.total_assignments ?? 0, totals?.total_started ?? 0,
                        isToday ? 1 : 0, isToday ? 1 : 0,
                        isToday ? 1 : 0, isToday ? 1 : 0, isToday ? 1 : 0,
                    ]
                );
            }

            // Recompute the streak from the snapshot history rather than
            // incrementing — self-heals when a day's row was missed and now
            // gets backfilled. Walk back from "today or yesterday" while
            // reviews_completed > 0.
            const today = days[days.length - 1].dateKey;
            const yesterday = days[days.length - 2].dateKey;
            const history = await db.all(
                `SELECT snapshot_date, reviews_completed FROM daily_snapshots
                 WHERE guild_id = ? AND discord_user_id = ?
                 ORDER BY snapshot_date DESC
                 LIMIT 365`,
                [guildId, row.discord_user_id]
            );
            const histMap = new Map(history.map(h => [h.snapshot_date, h.reviews_completed]));

            let currentStreak = 0;
            let lastReviewDate = null;
            // Anchor the streak at the most recent active day (today or yesterday).
            let cursor = (histMap.get(today) ?? 0) > 0
                ? today
                : ((histMap.get(yesterday) ?? 0) > 0 ? yesterday : null);
            while (cursor) {
                const reviews = histMap.get(cursor) ?? 0;
                if (reviews <= 0) break;
                currentStreak++;
                if (!lastReviewDate) lastReviewDate = cursor;
                // Step one calendar day backward in guild-local terms.
                const [yy, mm, dd] = cursor.split('-').map(Number);
                const prev = new Date(Date.UTC(yy, mm - 1, dd));
                prev.setUTCDate(prev.getUTCDate() - 1);
                cursor = prev.toISOString().slice(0, 10);
            }

            const prior = await db.get(
                `SELECT longest_streak, last_review_date FROM streaks
                 WHERE guild_id = ? AND discord_user_id = ?`,
                [guildId, row.discord_user_id]
            );
            const longest = Math.max(currentStreak, prior?.longest_streak ?? 0);
            const persistedLastDate = lastReviewDate ?? prior?.last_review_date ?? null;

            await db.run(
                `INSERT INTO streaks (guild_id, discord_user_id, current_streak, longest_streak, last_review_date)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
                    current_streak = excluded.current_streak,
                    longest_streak = excluded.longest_streak,
                    last_review_date = excluded.last_review_date,
                    updated_at = CURRENT_TIMESTAMP`,
                [guildId, row.discord_user_id, currentStreak, longest, persistedLastDate]
            );

            // Snapshot review_statistics for /mistakes baselines using today's
            // local date so the baseline join lines up with bot-day history.
            const recentStats = await db.all(
                `SELECT subject_id, meaning_incorrect, reading_incorrect, percentage_correct
                 FROM wk_review_statistics
                 WHERE wanikani_user_id = ? AND hidden = 0`,
                [row.wanikani_user_id]
            );
            for (const s of recentStats) {
                await db.run(
                    `INSERT INTO review_stat_snapshots (
                        wanikani_user_id, subject_id, snapshot_date,
                        meaning_incorrect, reading_incorrect, percentage_correct
                     ) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(wanikani_user_id, subject_id, snapshot_date) DO UPDATE SET
                        meaning_incorrect = excluded.meaning_incorrect,
                        reading_incorrect = excluded.reading_incorrect,
                        percentage_correct = excluded.percentage_correct`,
                    [
                        row.wanikani_user_id, s.subject_id, today,
                        s.meaning_incorrect || 0,
                        s.reading_incorrect || 0,
                        s.percentage_correct || 0,
                    ]
                );
            }

            await db.run(
                `DELETE FROM review_stat_snapshots
                 WHERE wanikani_user_id = ? AND snapshot_date < ?`,
                [row.wanikani_user_id, botDateStr(-14, timeZone)]
            );
        } catch (err) {
            console.error(`[snapshot] ${row.discord_user_id}@${guildId}:`, err.message);
        }
    }
}

// Per-account variant called from the 5-minute summaryRefreshJob. Looks up
// every guild this user belongs to and runs updateSnapshotsAndStreaks against
// it, so a user's heatmap and streak come alive within minutes of a review
// rather than waiting for the nightly daily job.
async function updateSnapshotsAndStreaksForAccount(account) {
    const memberships = await db.all(
        `SELECT guild_id FROM guild_members WHERE discord_user_id = ?`,
        [account.discord_user_id]
    );
    for (const m of memberships) {
        const row = {
            discord_user_id: account.discord_user_id,
            wanikani_user_id: account.wanikani_user_id,
            api_token_encrypted: account.api_token_encrypted,
        };
        await updateSnapshotsAndStreaks(m.guild_id, [row]);
    }
}

function botDateStr(dayOffset = 0, timeZone = undefined) {
    return addDaysToDateKey(botDateKey(new Date(), resolveTimeZone(timeZone)), dayOffset);
}

function utcDateStr(dayOffset = 0) {
    return botDateStr(dayOffset);
}

async function scheduleGuild(client, guildId) {
    clearGuildJobs(guildId);
    const settings = await getOrCreateSettings(guildId);
    const tz = resolveTimeZone(settings.timezone);

    addJob(guildId, cron.schedule(
        cronExpr(settings.daily_summary_time),
        () => dailyJob(client, guildId).catch(err => console.error('[dailyJob]', err)),
        { timezone: tz }
    ));

    if (settings.weekly_leaderboard_enabled) {
        addJob(guildId, cron.schedule(
            cronExpr(settings.weekly_leaderboard_time, settings.weekly_leaderboard_day),
            () => leaderboardJob(client, guildId).catch(err => console.error('[leaderboardJob]', err)),
            { timezone: tz }
        ));
    }
}

async function rescheduleGuild(client, guildId) {
    return scheduleGuild(client, guildId);
}

async function scheduleAll(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            await scheduleGuild(client, guild.id);
        } catch (err) {
            console.error(`[scheduleAll] guild=${guild.id}:`, err);
        }
    }
    // Summary refresh + per-account review-unlock timers (every 5 min, cheap thanks to ETag).
    if (!summaryRefreshJobHandle) {
        summaryRefreshJobHandle = cron.schedule(
            '*/5 * * * *',
            () => summaryRefreshJob(client).catch(err => console.error('[summaryRefreshJob]', err)),
            { timezone: 'UTC' }
        );
    }
    // Level-up / burn / reset detection (hourly — not time-critical).
    if (!slowDetectionJobHandle) {
        slowDetectionJobHandle = cron.schedule(
            '0 * * * *',
            () => slowDetectionJob(client).catch(err => console.error('[slowDetectionJob]', err)),
            { timezone: 'UTC' }
        );
    }
    // Daily globals (subjects, SRS systems) + slow per-user data (level progressions, review stats).
    if (!dailySyncJobHandle) {
        dailySyncJobHandle = cron.schedule(
            '0 4 * * *',
            () => dailyGlobalsAndUserSyncJob().catch(err => console.error('[dailyGlobalsJob]', err)),
            { timezone: 'UTC' }
        );
    }
    if (!paceAlertJobHandle) {
        paceAlertJobHandle = cron.schedule(
            '0 22 * * *',
            () => paceAlertJob(client).catch(err => console.error('[paceAlertJob]', err)),
            { timezone: 'UTC' }
        );
    }

    // Bootstrap: kick off an initial summary refresh so per-account timers are
    // populated immediately rather than waiting up to 5 minutes for the first cron tick.
    summaryRefreshJob(client).catch(err => console.error('[summaryRefreshJob/bootstrap]', err));
}

module.exports = {
    scheduleAll,
    scheduleGuild,
    rescheduleGuild,
    dailyJob,
    leaderboardJob,
    pollUsersJob,           // back-compat: now delegates to slowDetectionJob
    summaryRefreshJob,
    slowDetectionJob,
    dailyGlobalsAndUserSyncJob,
    paceAlertJob,
    updateSnapshotsAndStreaks,
    botDateStr,
    utcDateStr,
};
