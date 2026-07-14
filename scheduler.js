const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { decrypt } = require('./helpers/crypto');
const {
    getResetsSince,
    clearCacheForApiKey,
    getRemainingLessonsForGoal,
    computeFastestPaceDays,
} = require('./helpers/wanikaniData');
const { projectPace } = require('./helpers/longgoal');
const { buildDailyRecap } = require('./helpers/dailyRecap');
const wkSync = require('./helpers/wkSync');
const { COLOR_PRIMARY, COLOR_ERROR, COLOR_WARN, FOOTER } = require('./helpers/embeds');
const { recordPoll } = require('./helpers/zerostate');
const { pickShameLine } = require('./helpers/shame');
const { generateShameLine } = require('./helpers/anthropic');
const { logReminderEvent } = require('./helpers/reminderEvents');
const { isWithinSleepWindow } = require('./helpers/sleepHours');
const { evaluateAchievements } = require('./helpers/achievements');
const { evaluateGuildAchievements } = require('./helpers/guildAchievements');
const { writeReviewStatSnapshots } = require('./helpers/reviewStatSnapshot');
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
let hourlyReviewCatchupJobHandle = null;
let slowDetectionJobHandle = null;
let dailySyncJobHandle = null;
let paceAlertJobHandle = null;

const ONE_HOUR_MS = 60 * 60 * 1000;

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

// Returns one row per (guild_member with linked WK account), with both
// per-guild reminder flags and user-level prefs folded in. Defaults match
// each layer's defaults.
async function getGuildMembers(guildId) {
    return db.all(
        `SELECT
             gm.discord_user_id,
             wa.wanikani_user_id,
             wa.api_token_encrypted,
             COALESCE(rs.reviews_ping_enabled, 1) AS ping_enabled,
             COALESCE(rs.shame_enabled, 0) AS shame_enabled,
             COALESCE(rs.cleared_enabled, 1) AS cleared_enabled,
             COALESCE(rs.levelup_announcement_enabled, 1) AS levelup_announcement_enabled,
             COALESCE(urs.shame_enabled, 0) AS user_shame_enabled
         FROM guild_members gm
         JOIN wanikani_accounts wa ON wa.discord_user_id = gm.discord_user_id
         LEFT JOIN reminder_settings rs
             ON rs.guild_id = gm.guild_id AND rs.discord_user_id = gm.discord_user_id
         LEFT JOIN user_reminder_settings urs
             ON urs.discord_user_id = gm.discord_user_id
         WHERE gm.guild_id = ?`,
        [guildId]
    );
}

async function dailyJob(client, guildId) {
    console.log(`[daily] guild=${guildId}`);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const settings = await getOrCreateSettings(guildId);

    const rows = await getGuildMembers(guildId);
    if (rows.length === 0) return;

    const tz = resolveTimeZone(settings.timezone);
    // The day being closed: one minute before the job fired. At the default
    // midnight schedule that's yesterday; for a late-evening summary time
    // it's the (almost-complete) current day.
    const recapDateKey = botDateKey(new Date(Date.now() - 60 * 1000), tz);

    // Snapshots first so the recap reads finalized data for the closing day.
    await updateSnapshotsAndStreaks(guildId, rows);

    if (settings.daily_summary_enabled) {
        const channel = await resolveOutputChannel(guild, settings);
        if (channel) {
            const recap = await buildDailyRecap(guildId, guild, tz, recapDateKey);
            if (recap) {
                const embed = new EmbedBuilder()
                    .setColor(COLOR_PRIMARY)
                    .setTitle(recap.title)
                    .setDescription(recap.description)
                    .setTimestamp()
                    .setFooter(FOOTER);
                if (recap.fields.length) embed.addFields(...recap.fields);

                const pingList = rows.filter(r => r.ping_enabled === 1).map(r => `<@${r.discord_user_id}>`);
                const sent = await channel.send({
                    content: pingList.length ? pingList.join(' ') : undefined,
                    embeds: [embed],
                });
                // Log one daily_summary event per member so /reminders history reflects them.
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
                    }).catch(e => console.error('[logReminderEvent/daily]', e));
                }
            }
        }
    }

    // Server-wide achievements run after snapshots so aggregate totals reflect
    // today's activity. Announce newly unlocked ones to the output channel.
    try {
        const unlocked = await evaluateGuildAchievements(guildId);
        if (unlocked.length) {
            const channel = await resolveOutputChannel(guild, settings);
            if (channel) {
                const defs = await db.all(
                    `SELECT achievement_key, name, description FROM achievement_definitions
                     WHERE achievement_key IN (${unlocked.map(() => '?').join(',')})`,
                    unlocked
                );
                const lines = defs.map(d => `🏆 **${d.name}** — ${d.description}`);
                const embed = new EmbedBuilder()
                    .setColor(COLOR_PRIMARY)
                    .setTitle('🏰 Server Achievement Unlocked!')
                    .setDescription(lines.join('\n'))
                    .setTimestamp()
                    .setFooter(FOOTER);
                await channel.send({ embeds: [embed] });
            }
        }
    } catch (err) {
        console.error(`[guildAchievements] ${guildId}:`, err);
    }
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
             wa.current_vacation_started_at,
             COALESCE(rs.shame_enabled, 0) AS shame_enabled,
             COALESCE(rs.reviews_ping_enabled, 1) AS ping_enabled,
             COALESCE(SUM(ds.reviews_completed), 0) AS reviews,
             COALESCE(SUM(ds.lessons_completed), 0) AS lessons
         FROM guild_members gm
         LEFT JOIN wanikani_accounts wa ON wa.discord_user_id = gm.discord_user_id
         LEFT JOIN daily_snapshots ds
             ON ds.guild_id = gm.guild_id
             AND ds.discord_user_id = gm.discord_user_id
             AND ds.snapshot_date >= ?
         LEFT JOIN reminder_settings rs
             ON rs.guild_id = gm.guild_id AND rs.discord_user_id = gm.discord_user_id
         WHERE gm.guild_id = ?
         GROUP BY gm.discord_user_id, wa.current_vacation_started_at, rs.shame_enabled, rs.reviews_ping_enabled
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
            onVacation: r.current_vacation_started_at != null,
            pingEnabled: r.ping_enabled === 1,
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

    const shameTargets = enriched.filter(e => e.shameEnabled && e.reviews === 0 && !e.onVacation);
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

    const pingList = enriched.filter(e => e.pingEnabled).map(e => `<@${e.userId}>`);
    await channel.send({
        content: pingList.length ? pingList.join(' ') : undefined,
        embeds: [embed],
    });
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
        console.error(`[reset check] ${discordUserId}@${guildId}:`, err);
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
// Per-guild work (queue_history bookkeeping) runs in the same job because it
// also depends on the freshly-synced summary.

const reviewTimers = new Map(); // wanikani_user_id -> NodeJS.Timeout
// Prevents the concurrent summaryRefreshJob + hourlyReviewCatchupJob calls that
// both fire at HH:00 from racing through maybeSendReviewsAvailableDM and
// double-sending. JS is single-threaded so the has()+add() pair is atomic.
const dmSendInFlight = new Set(); // wanikani_user_id values currently inside maybeSendReviewsAvailableDM

async function summaryRefreshJob(client) {
    const accounts = await db.all(
        `SELECT DISTINCT wanikani_user_id, discord_user_id, api_token_encrypted
         FROM wanikani_accounts`
    );
    for (const account of accounts) {
        try {
            await wkSync.syncSummary(account);
            await maybeResetReviewsAlertBaseline(account);
            // Catch up on any unlock that already passed without a DM —
            // happens after a bot restart (the in-memory timer map is empty
            // at boot and only the *next future* bucket gets a timer) or for
            // a freshly-linked account whose current queue is already due.
            await maybeSendReviewsAvailableDM(client, account).catch(err =>
                console.error(`[summaryRefresh/catchupDM] ${account.wanikani_user_id}:`, err)
            );
            await scheduleNextReviewTimer(client, account);
            await updateSnapshotsAndStreaksForAccount(account).catch(err =>
                console.error(`[summaryRefresh/snapshots] ${account.wanikani_user_id}:`, err)
            );
        } catch (err) {
            console.error(`[summaryRefresh] ${account.wanikani_user_id}:`, err);
        }
    }

    // Per-guild queue_history bookkeeping. This feeds the daily recap's
    // queue-clears digest and the clear-queue goal evaluation, so it must
    // keep polling even though the real-time cleared announcement is gone.
    for (const guild of client.guilds.cache.values()) {
        try {
            const rows = await getGuildMembers(guild.id);
            for (const row of rows) {
                try {
                    const cache = await db.get(
                        `SELECT review_count_now FROM wk_summary_cache WHERE wanikani_user_id = ?`,
                        [row.wanikani_user_id]
                    );
                    await recordPoll(row.discord_user_id, guild.id, cache?.review_count_now ?? 0, row.wanikani_user_id);
                } catch (err) {
                    console.error(`[summaryRefresh/guild] ${row.discord_user_id}@${guild.id}:`, err);
                }
            }
        } catch (err) {
            console.error('[summaryRefresh] guild loop:', err);
        }
    }
}

// Top-of-hour catchup. Runs at HH:00 alongside the regular */5 tick so that
// at the moment reviews unlock — every WK reviews bucket lands on the hour —
// the DM goes out within seconds even if the per-account setTimeout missed.
// Cheaper than summaryRefreshJob: skips per-guild queue_history work and
// snapshot/streak updates (the */5 tick still handles those).
async function hourlyReviewCatchupJob(client) {
    const accounts = await db.all(
        `SELECT DISTINCT wanikani_user_id, discord_user_id, api_token_encrypted
         FROM wanikani_accounts`
    );
    for (const account of accounts) {
        try {
            await wkSync.syncSummary(account);
            await maybeResetReviewsAlertBaseline(account);
            await maybeSendReviewsAvailableDM(client, account);
            await scheduleNextReviewTimer(client, account);
        } catch (err) {
            console.error(`[hourlyReviewCatchup] ${account.wanikani_user_id}:`, err);
        }
    }
}

// Reset the reviews-available alert baseline whenever the queue is observed
// empty so that the next batch of unlocks correctly registers as "new
// reviews". Also keeps the baseline in sync if the user does reviews without
// ever fully clearing — once the count drops below the prior alert level, we
// shrink the baseline so growth back above it triggers exactly one alert.
async function maybeResetReviewsAlertBaseline(account) {
    const cache = await db.get(
        `SELECT review_count_now FROM wk_summary_cache WHERE wanikani_user_id = ?`,
        [account.wanikani_user_id]
    );
    const dueRightNow = cache?.review_count_now ?? 0;
    const acct = await db.get(
        `SELECT last_reviews_alerted_count FROM wanikani_accounts WHERE wanikani_user_id = ?`,
        [account.wanikani_user_id]
    );
    if (!acct) return;
    const prev = acct.last_reviews_alerted_count ?? 0;
    if (dueRightNow < prev) {
        await db.run(
            `UPDATE wanikani_accounts
                SET last_reviews_alerted_count = ?, updated_at = CURRENT_TIMESTAMP
              WHERE wanikani_user_id = ?`,
            [dueRightNow, account.wanikani_user_id]
        );
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
    // re-schedule), and add a tiny buffer so the unlock boundary is safely past
    // when maybeSendReviewsAvailableDM reads the bucket table.
    if (ms > 24 * 60 * 60 * 1000) return;
    if (ms < 0) ms = 0;
    ms += 5 * 1000;

    const timer = setTimeout(() => {
        reviewTimers.delete(wkId);
        reviewTimerFired(client, account).catch(err =>
            console.error(`[reviewTimer] ${wkId}:`, err)
        );
    }, ms);
    reviewTimers.set(wkId, timer);
}

async function reviewTimerFired(client, account) {
    // Refresh /summary so review_count_now reflects the unlock we're firing for.
    try {
        await wkSync.syncSummary(account);
    } catch (err) {
        console.warn(`[reviewTimer/syncSummary] ${account.wanikani_user_id}:`, err);
    }
    await maybeSendReviewsAvailableDM(client, account);
    await scheduleNextReviewTimer(client, account);
}

// Decide whether the user should get a "reviews available" DM right now and,
// if so, send it. Callable from both the per-account setTimeout (`reviewTimerFired`)
// and the 5-minute `summaryRefreshJob` so that buckets which transitioned during
// bot downtime — or queues that were already due when the user first linked,
// before any timer existed — get caught up on the next cron tick instead of
// silently waiting for a future bucket unlock that may be hours away.
//
// Idempotent against repeated calls thanks to the 5-minute floor on
// `last_reviews_alerted_at` and the `dueRightNow > prevCount` check.
async function maybeSendReviewsAvailableDM(client, account) {
    if (dmSendInFlight.has(account.wanikani_user_id)) return;
    dmSendInFlight.add(account.wanikani_user_id);
    try {
    // Opt-in lives in user_reminder_settings (true cross-guild scope — the DM
    // is user-scoped). No row = default-on, matching the pre-split behavior.
    const userPrefs = await db.get(
        `SELECT reviews_dm_enabled FROM user_reminder_settings WHERE discord_user_id = ?`,
        [account.discord_user_id]
    );
    const reviewsDmEnabled = userPrefs ? userPrefs.reviews_dm_enabled === 1 : true;
    if (!reviewsDmEnabled) return;

    if (await isWithinSleepWindow(account.discord_user_id)) return;

    const acctState = await db.get(
        `SELECT last_reviews_alerted_at, last_reviews_alerted_count
         FROM wanikani_accounts WHERE wanikani_user_id = ?`,
        [account.wanikani_user_id]
    );

    // Compute the live "due now" count from our local bucket table rather than
    // trusting wk_summary_cache.review_count_now: WK's /summary endpoint can
    // return stale review counts right at an unlock boundary, which used to
    // make the per-account timer (firing at unlock+30s) miss the DM and wait
    // for the next 5-minute cron tick.
    const live = await db.get(
        `SELECT COALESCE(SUM(subject_count), 0) AS due_now
         FROM wk_summary_buckets
         WHERE wanikani_user_id = ?
           AND bucket_type = 'review'
           AND datetime(available_at) <= datetime('now')`,
        [account.wanikani_user_id]
    );
    const dueRightNow = live?.due_now ?? 0;

    // When the queue empties, reset the alert baseline so the next unlock
    // is correctly recognised as "new reviews".
    if (dueRightNow <= 0) {
        if ((acctState?.last_reviews_alerted_count ?? 0) !== 0) {
            await db.run(
                `UPDATE wanikani_accounts
                    SET last_reviews_alerted_count = 0, updated_at = CURRENT_TIMESTAMP
                  WHERE wanikani_user_id = ?`,
                [account.wanikani_user_id]
            );
        }
        return;
    }

    // Only alert when the count actually grew since the last alert — otherwise
    // a non-empty queue would re-page the user every time the cron tick fires.
    const prevCount = acctState?.last_reviews_alerted_count ?? 0;
    if (dueRightNow <= prevCount) return;

    // Floor against rapid re-fires: if we DM'd this user in the last 5 minutes
    // (either via timer or via a previous catch-up tick), don't spam them.
    if (acctState?.last_reviews_alerted_at) {
        const ageMs = Date.now() - new Date(acctState.last_reviews_alerted_at).getTime();
        if (ageMs >= 0 && ageMs < 5 * 60 * 1000) return;
    }

    const nextBucket = await db.get(
        `SELECT available_at, subject_count FROM wk_summary_buckets
         WHERE wanikani_user_id = ? AND bucket_type = 'review'
           AND datetime(available_at) > datetime('now')
         ORDER BY available_at ASC LIMIT 1`,
        [account.wanikani_user_id]
    );

    const user = await client.users.fetch(account.discord_user_id).catch(() => null);
    if (!user) return;

    const newlyAvailable = Math.max(0, dueRightNow - prevCount);
    const lines = [
        `**${newlyAvailable}** new review${newlyAvailable === 1 ? '' : 's'} just became available.`,
        `Total in queue: **${dueRightNow}**.`,
        '',
        '[**Start reviews →**](https://www.wanikani.com/subjects/review)',
    ];
    if (nextBucket) {
        const ts = Math.floor(new Date(nextBucket.available_at).getTime() / 1000);
        lines.push(`Next batch: **+${nextBucket.subject_count}** <t:${ts}:R> (<t:${ts}:t>).`);
    }
    lines.push(
        '',
        'Disable with `/setup reviews_dm:false`.'
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
            `UPDATE wanikani_accounts
                SET last_reviews_alerted_at = ?,
                    last_reviews_alerted_count = ?,
                    updated_at = CURRENT_TIMESTAMP
              WHERE wanikani_user_id = ?`,
            [new Date().toISOString(), dueRightNow, account.wanikani_user_id]
        );
        await logReminderEvent({
            discordUserId: account.discord_user_id,
            wanikaniUserId: account.wanikani_user_id,
            reminderType: 'reviews_available',
            deliveryTarget: 'dm',
            reviewCount: dueRightNow,
            messageId: sent?.id ?? null,
            status: 'sent',
        }).catch(e => console.error('[logReminderEvent]', e));
    } catch (err) {
        console.warn(`[reviewDM] ${account.discord_user_id}:`, err);
        await logReminderEvent({
            discordUserId: account.discord_user_id,
            wanikaniUserId: account.wanikani_user_id,
            reminderType: 'reviews_available',
            deliveryTarget: 'dm',
            reviewCount: dueRightNow,
            status: 'failed',
            error: err.message,
        }).catch(e => console.error('[logReminderEvent/failed reviewDM]', e));
    }
    } finally {
        dmSendInFlight.delete(account.wanikani_user_id);
    }
}

// ── slow-loop detection (hourly) ────────────────────────────────────────
// Replaces the old 15-minute pollUsersJob. Level-up / reset detection is not
// time-critical, so it runs once per hour against freshly-synced caches.

async function slowDetectionJob(client) {
    // Sync each WaniKani account exactly once per tick, before any guild loop
    // runs. Level-ups are detected against the `last_announced_level`
    // watermark rather than a before/after read of `level`: the 5-minute
    // summaryRefreshJob also syncs /user, so `level` is usually already
    // current when this job runs and a before/after diff is always zero.
    // Only this job's announcement path moves the watermark.
    const accountRows = await db.all(
        `SELECT DISTINCT wa.wanikani_user_id, wa.discord_user_id, wa.api_token_encrypted
         FROM wanikani_accounts wa
         JOIN guild_members gm ON gm.discord_user_id = wa.discord_user_id`
    );

    const accountState = new Map(); // wanikani_user_id -> { level, leveledUp }
    for (const row of accountRows) {
        try {
            await wkSync.syncUser(row);
            await wkSync.syncAssignments(row);

            const account = await db.get(
                `SELECT level, last_announced_level FROM wanikani_accounts
                 WHERE wanikani_user_id = ?`,
                [row.wanikani_user_id]
            );
            const level = account?.level ?? null;
            const watermark = account?.last_announced_level ?? null;
            if (level === null) continue;

            if (watermark === null || level < watermark) {
                // First sync (no watermark yet) or a level reset: align the
                // watermark silently so we never announce stale or downward
                // movement.
                await db.run(
                    `UPDATE wanikani_accounts SET last_announced_level = ?
                     WHERE wanikani_user_id = ?`,
                    [level, row.wanikani_user_id]
                );
                if (watermark === null) {
                    console.log(`[slowDetection] ${row.discord_user_id}: no prior announced level, initializing watermark at ${level}`);
                }
            }
            accountState.set(row.wanikani_user_id, {
                level,
                leveledUp: watermark !== null && level > watermark,
            });
        } catch (err) {
            console.error(`[slowDetection/sync] ${row.wanikani_user_id}:`, err);
        }
    }

    for (const guild of client.guilds.cache.values()) {
        try {
            const settings = await getOrCreateSettings(guild.id);
            const channel = await resolveOutputChannel(guild, settings);
            const rows = await getGuildMembers(guild.id);
            for (const row of rows) {
                try {
                    const apiKey = decrypt(row.api_token_encrypted);
                    const state = accountState.get(row.wanikani_user_id);
                    if (!state) continue;
                    const { level, leveledUp } = state;

                    const lastResetState = await db.get(
                        `SELECT last_reset_checked_at FROM bot_user_state
                         WHERE guild_id = ? AND discord_user_id = ?`,
                        [guild.id, row.discord_user_id]
                    );
                    await checkUserResets(apiKey, row.discord_user_id, guild.id, row.wanikani_user_id, lastResetState?.last_reset_checked_at ?? null);

                    if (
                        channel &&
                        settings.level_up_announcements_enabled &&
                        row.levelup_announcement_enabled !== 0 &&
                        leveledUp
                    ) {
                        const embed = new EmbedBuilder()
                            .setColor(COLOR_PRIMARY)
                            .setTitle('🎉 Level Up!')
                            .setDescription(`<@${row.discord_user_id}> just reached **level ${level}**!`)
                            .setTimestamp()
                            .setFooter(FOOTER);
                        await channel.send({ content: `<@${row.discord_user_id}>`, embeds: [embed] });
                    }

                    // Achievement check — runs against freshly-synced state.
                    await evaluateAchievements({
                        discordUserId: row.discord_user_id,
                        wanikaniUserId: row.wanikani_user_id,
                    }).catch(e => console.error('[achievements]', e));
                } catch (err) {
                    console.error(`[slowDetection] ${row.discord_user_id}@${guild.id}:`, err);
                }
            }
        } catch (err) {
            console.error('[slowDetection] guild loop:', err);
        }
    }

    // Advance watermarks only after every guild has had its chance to
    // announce — moving it inside the guild loop would re-introduce the old
    // multi-guild bug (first guild announces, the rest see no diff). If a
    // single send failed above, the watermark still advances: a rare missed
    // announcement beats re-announcing in every other guild each hour.
    for (const [wanikaniUserId, state] of accountState) {
        if (!state.leveledUp) continue;
        await db.run(
            `UPDATE wanikani_accounts SET last_announced_level = ?
             WHERE wanikani_user_id = ?`,
            [state.level, wanikaniUserId]
        ).catch(err => console.error(`[slowDetection/watermark] ${wanikaniUserId}:`, err));
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
                console.error('[dailyGlobals] srs:', e));
            await wkSync.syncSubjects(apiKey).catch(e =>
                console.error('[dailyGlobals] subjects:', e));
        } catch (err) {
            console.error('[dailyGlobals]', err);
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
            console.error(`[dailyUserSync] ${account.wanikani_user_id}:`, err);
        }
    }

}

// Back-compat: pollUsersJob now just runs the slow-loop detection so any
// callers (tests, manual triggers) keep working.
async function pollUsersJob(client) {
    return slowDetectionJob(client);
}

async function paceAlertJob(client) {
    const goals = await db.all(`SELECT * FROM user_goals WHERE notify_enabled = 1`);

    for (const goal of goals) {
        try {
            // Pick the user's primary guild timezone so "same bot-day" lines
            // up with the day they perceive (their daily summary's day).
            const tzRow = await db.get(
                `SELECT gs.timezone FROM guild_members gm
                 JOIN guild_settings gs ON gs.guild_id = gm.guild_id
                 WHERE gm.discord_user_id = ?
                 ORDER BY gm.joined_bot_at ASC LIMIT 1`,
                [goal.discord_user_id]
            );
            const tz = resolveTimeZone(tzRow?.timezone);
            const todayKey = botDateStr(0, tz);
            if (goal.last_alerted_at) {
                const lastDayKey = botDateKey(new Date(goal.last_alerted_at), tz);
                if (lastDayKey === todayKey) continue;
            }

            // Load fresh account state — current level drives the projection,
            // and we need the api token for the SRS-derived floor.
            const account = await db.get(
                `SELECT wanikani_user_id, level, api_token_encrypted
                 FROM wanikani_accounts WHERE wanikani_user_id = ?`,
                [goal.wanikani_user_id]
            );

            // Always refresh the projection timestamp so /goals callers and
            // ops can tell when the job last evaluated this goal — even if no
            // alert is emitted today.
            await db.run(
                `UPDATE user_goals SET last_projection_at = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE discord_user_id = ?`,
                [new Date().toISOString(), goal.discord_user_id]
            );

            // Severity ladder: attainability → cumulative pace → today's
            // ratio. Higher tiers subsume lower ones so we only send the most
            // serious applicable alert (and the same-bot-day gate above keeps
            // us from re-paging within the user's day).
            let embed = null;
            if (account && goal.deadline && goal.target_level > account.level) {
                const [itemCounts, fastest] = await Promise.all([
                    getRemainingLessonsForGoal(account, goal.target_level, account.level).catch(() => null),
                    computeFastestPaceDays(account, account.level, goal.target_level).catch(() => null),
                ]);
                const physicalProj = projectPace({
                    targetLevel: goal.target_level,
                    currentLevel: account.level,
                    deadline: goal.deadline,
                    hitRate: 1.0,
                    dailyLessons: goal.daily_lessons,
                    itemCounts,
                    srsDaysPerLevel: fastest?.avgDaysPerLevel,
                });

                if (physicalProj.underWaniKaniMinimum) {
                    const levelsRemaining = physicalProj.levelsRemaining;
                    embed = new EmbedBuilder()
                        .setColor(COLOR_ERROR)
                        .setTitle('⛔ Goal no longer attainable')
                        .setDescription([
                            `Your deadline is **${goal.deadline}** (${physicalProj.daysRemaining} day${physicalProj.daysRemaining === 1 ? '' : 's'} away), but reaching **Level ${goal.target_level}** from Level ${account.level} now needs at least **${physicalProj.minimumSrsDays} days** under WaniKani's SRS timing.`,
                            `That's ${levelsRemaining} level${levelsRemaining === 1 ? '' : 's'} to clear and the SRS timing simply doesn't fit anymore.`,
                            '',
                            'Run `/goals` to extend the deadline, lower the target, or clear the goal.',
                            '',
                            'Disable with `/goals` → Configure alerts.',
                        ].join('\n'))
                        .setTimestamp()
                        .setFooter(FOOTER);
                } else if (!physicalProj.feasibleAtPace) {
                    const overshoot = physicalProj.projectedDays - physicalProj.daysRemaining;
                    embed = new EmbedBuilder()
                        .setColor(COLOR_WARN)
                        .setTitle('⚠️ Falling behind your goal')
                        .setDescription([
                            `At **${physicalProj.lessonsPerDay} lessons/day** you'd finish around **${physicalProj.projectedFinish}** — about **${overshoot} day${overshoot === 1 ? '' : 's'}** past your deadline (${goal.deadline}).`,
                            `${physicalProj.totalLessons} lesson${physicalProj.totalLessons === 1 ? '' : 's'} remain across ${physicalProj.levelsRemaining} level${physicalProj.levelsRemaining === 1 ? '' : 's'}.`,
                            'Bumping your daily lessons up will close the gap; run `/goals` to adjust.',
                            '',
                            'Disable with `/goals` → Configure alerts.',
                        ].join('\n'))
                        .setTimestamp()
                        .setFooter(FOOTER);
                }
            }

            // Tier 3 — daily lesson ratio, only when nothing more serious
            // is firing. Reads the user's same-day snapshot across all guilds
            // they're in and takes the max (one server's count is enough).
            if (!embed) {
                const target = goal.daily_lessons || 0;
                if (target === 0) continue;
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
                if (lessonsToday / target >= 0.5) continue;

                embed = new EmbedBuilder()
                    .setColor(COLOR_WARN)
                    .setTitle('⏳ Behind pace today')
                    .setDescription([
                        `You've done **${lessonsToday}/${target}** lessons today.`,
                        goal.target_level
                            ? `Goal: level **${goal.target_level}**${goal.deadline ? ` by **${goal.deadline}**` : ''}.`
                            : `Goal: **${target}** lessons/day.`,
                        'Try to log a session today to stay on track.',
                        '',
                        'Disable with `/goals` → Configure alerts.',
                    ].join('\n'))
                    .setTimestamp()
                    .setFooter(FOOTER);
            }

            const user = await client.users.fetch(goal.discord_user_id).catch(() => null);
            if (!user) continue;

            try {
                await user.send({ embeds: [embed] });
                await db.run(
                    `UPDATE user_goals SET last_alerted_at = ?, updated_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?`,
                    [new Date().toISOString(), goal.discord_user_id]
                );
            } catch (err) {
                console.warn(`[paceDM] ${goal.discord_user_id}:`, err);
            }
        } catch (err) {
            console.error(`[paceAlert] ${goal.discord_user_id}:`, err);
        }
    }
}

// Fires ~2 hours before the guild's daily_summary_time. For each member with
// an active streak whose last review was yesterday (not today, in *their*
// timezone), checks the live queue: if reviews are due and none have been done
// today, the streak is at risk. Sends either a shame DM (if the user opted in)
// or a gentle nudge.
async function streakRiskJob(client, guildId) {
    console.log(`[streakRisk] guild=${guildId}`);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const settings = await getOrCreateSettings(guildId);
    const guildTz = resolveTimeZone(settings.timezone);
    const { getEffectiveUserTimeZone } = require('./helpers/tzInfer');

    // Streak DM + shame variant are user-scoped preferences (DMs are
    // inherently cross-guild). Defaults match user_reminder_settings: streak
    // on, shame off.
    // Date filtering is intentionally absent here — each user's "today" and
    // "yesterday" are resolved per-user below using their effective timezone.
    const candidates = await db.all(
        `SELECT
             gm.discord_user_id,
             wa.wanikani_user_id,
             wa.current_vacation_started_at,
             s.current_streak,
             s.last_review_date,
             COALESCE(urs.streak_reminder_enabled, 1) AS streak_reminder_enabled,
             COALESCE(urs.shame_enabled, 0) AS shame_enabled,
             COALESCE(cache.review_count_now, 0) AS due_now
         FROM guild_members gm
         JOIN wanikani_accounts wa ON wa.discord_user_id = gm.discord_user_id
         JOIN streaks s ON s.guild_id = gm.guild_id AND s.discord_user_id = gm.discord_user_id
         LEFT JOIN user_reminder_settings urs ON urs.discord_user_id = gm.discord_user_id
         LEFT JOIN wk_summary_cache cache ON cache.wanikani_user_id = wa.wanikani_user_id
         WHERE gm.guild_id = ?
           AND s.current_streak >= 1`,
        [guildId]
    );

    for (const c of candidates) {
        if (c.current_vacation_started_at) continue;
        if (c.due_now <= 0) continue;

        // Resolve the user's own timezone so "today" and "yesterday" line up
        // with the same day boundaries used when writing their snapshots.
        const { timeZone: userTz } = await getEffectiveUserTimeZone(c.discord_user_id, guildTz);
        const userToday = botDateStr(0, userTz);
        const userYesterday = botDateStr(-1, userTz);

        // Only at risk if their last review was yesterday (in their tz) and
        // they haven't done any reviews yet today (in their tz).
        if (c.last_review_date !== userYesterday) continue;
        const snapToday = await db.get(
            `SELECT reviews_completed FROM daily_snapshots
             WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date = ?`,
            [guildId, c.discord_user_id, userToday]
        );
        if ((snapToday?.reviews_completed ?? 0) > 0) continue;

        const wantsShame = c.shame_enabled === 1;
        const wantsGentle = c.streak_reminder_enabled === 1;
        if (!wantsShame && !wantsGentle) continue;
        if (await isWithinSleepWindow(c.discord_user_id)) continue;

        // Cross-guild dedupe: streak-risk crons run per-guild, but the DM is
        // user-scoped. If we already sent (or attempted) a streak DM in the
        // last 12h skip this one so members of multiple servers don't get
        // duplicate (and sometimes mismatched variant) reminders.
        const recent = await db.get(
            `SELECT 1 AS hit FROM reminder_events
             WHERE discord_user_id = ?
               AND reminder_type IN ('streak_risk', 'shame')
               AND delivery_target = 'dm'
               AND sent_at IS NOT NULL
               AND datetime(sent_at) > datetime('now', '-12 hours')
             LIMIT 1`,
            [c.discord_user_id]
        );
        if (recent) continue;

        try {
            const user = await client.users.fetch(c.discord_user_id).catch(() => null);
            if (!user) continue;

            let embed;
            if (wantsShame) {
                const userTag = `<@${c.discord_user_id}>`;
                const ctx = await fetchShameContext(c.discord_user_id);
                const generated = await generateShameLine({
                    user: userTag,
                    name: '',
                    lessons: 0,
                    medal: '',
                    level: ctx.level,
                    knownKanji: ctx.knownKanji,
                }).catch(() => null);
                const body = generated ?? pickShameLine({ user: userTag });
                embed = new EmbedBuilder()
                    .setColor(COLOR_WARN)
                    .setTitle(`💢 Your ${c.current_streak}-day streak is on the line`)
                    .setDescription([
                        body,
                        '',
                        `**${c.due_now}** review${c.due_now === 1 ? '' : 's'} waiting · **${c.current_streak}**-day streak at risk.`,
                        '[**Start reviews →**](https://www.wanikani.com/subjects/review)',
                        '-# Clear at least one review today to keep the streak alive.',
                    ].join('\n'))
                    .setTimestamp()
                    .setFooter(FOOTER);
            } else {
                embed = new EmbedBuilder()
                    .setColor(COLOR_WARN)
                    .setTitle('🔥 Streak about to break')
                    .setDescription([
                        `You have **${c.due_now}** review${c.due_now === 1 ? '' : 's'} waiting and a **${c.current_streak}**-day streak on the line.`,
                        '[**Start reviews →**](https://www.wanikani.com/subjects/review)',
                        'Clear at least one review today to keep the streak alive.',
                        '',
                        'Disable with `/setup` (streak reminders).',
                    ].join('\n'))
                    .setTimestamp()
                    .setFooter(FOOTER);
            }

            const sent = await user.send({ embeds: [embed] });
            await logReminderEvent({
                guildId,
                discordUserId: c.discord_user_id,
                wanikaniUserId: c.wanikani_user_id,
                reminderType: wantsShame ? 'shame' : 'streak_risk',
                deliveryTarget: 'dm',
                reviewCount: c.due_now,
                messageId: sent?.id ?? null,
                status: 'sent',
            }).catch(e => console.error('[logReminderEvent/streakRisk]', e));
        } catch (err) {
            console.warn(`[streakRisk] ${c.discord_user_id}@${guildId}:`, err);
            await logReminderEvent({
                guildId,
                discordUserId: c.discord_user_id,
                wanikaniUserId: c.wanikani_user_id,
                reminderType: wantsShame ? 'shame' : 'streak_risk',
                deliveryTarget: 'dm',
                reviewCount: c.due_now,
                status: 'failed',
                error: err.message,
            }).catch(e => console.error('[logReminderEvent/streakRisk failed]', e));
        }
    }
}

function shiftTime(time, deltaHours) {
    const [h, m] = time.split(':').map(Number);
    const total = (h * 60 + m + deltaHours * 60 + 24 * 60) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Number of days the per-call lookback covers. Choosing 3 means we backfill
// "today / yesterday / day-before" on every run — enough to recover from a
// missed cron without making the loop expensive.
const SNAPSHOT_LOOKBACK_DAYS = 3;

// Vacation-mode entry/exit re-stamps every assignment's data_updated_at at
// once. A real human review session never produces 50 items in the same
// wall-clock second, so we treat any such cluster as a WK-side bulk mutation
// and drop it from the review/lesson buckets.
const BULK_UPDATE_SECOND_THRESHOLD = 50;

async function updateSnapshotsAndStreaks(guildId, rows, options = {}) {
    const settings = await getOrCreateSettings(guildId);
    const guildTimeZone = resolveTimeZone(settings.timezone);
    const {
        ensureUserSynced, ensureSummarySynced, ensureReviewStatsSynced,
        getCompletedItemsSince, getSrsBreakdown,
    } = require('./helpers/wanikaniData');
    const { getEffectiveUserTimeZone } = require('./helpers/tzInfer');
    const userMaxAgeMs = options.userMaxAgeMs ?? 0;
    const summaryMaxAgeMs = options.summaryMaxAgeMs ?? 60 * 1000;
    const reviewStatsMaxAgeMs = options.reviewStatsMaxAgeMs ?? 0;
    const assignmentMaxAgeMs = options.assignmentMaxAgeMs ?? 4 * 60 * 1000;

    for (const row of rows) {
        try {
            // Bucket each user's activity by *their* local days — explicit
            // /timezone override, else the guild timezone (defaults to JST).
            // Day keys stay YYYY-MM-DD so snapshot consumers don't care that
            // two users in the same guild close their days at different UTC
            // instants.
            const { timeZone } = await getEffectiveUserTimeZone(row.discord_user_id, guildTimeZone);
            const days = [];
            for (let i = SNAPSHOT_LOOKBACK_DAYS - 1; i >= 0; i--) {
                const dateKey = botDateStr(-i, timeZone);
                const startISO = startOfBotDayUtcIso(dateKey, timeZone);
                const endISO = startOfBotDayUtcIso(botDateStr(-i + 1, timeZone), timeZone);
                days.push({ dateKey, startISO, endISO });
            }
            const earliestStartISO = days[0].startISO;

            await ensureUserSynced(row, userMaxAgeMs);
            await ensureSummarySynced(row, summaryMaxAgeMs);
            await ensureReviewStatsSynced(row, reviewStatsMaxAgeMs);

            const acct = await db.get(
                `SELECT level FROM wanikani_accounts WHERE wanikani_user_id = ?`,
                [row.wanikani_user_id]
            );
            const level = acct?.level ?? 0;
            // ensureAssignmentsSynced is invoked inside getCompletedItemsSince
            // with a 4-min staleness floor — back-to-back callers (e.g. the
            // 5-min summaryRefreshJob) won't pile up redundant syncs.
            const items = await getCompletedItemsSince(row, earliestStartISO, assignmentMaxAgeMs);
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

            // Bucket activity into per-day counts.
            const perSecondCounts = new Map();
            for (const it of items) {
                const sec = Math.floor(new Date(it.data_updated_at).getTime() / 1000);
                perSecondCounts.set(sec, (perSecondCounts.get(sec) || 0) + 1);
            }
            let bulkFiltered = 0;
            const byDay = new Map(days.map(d => [d.dateKey, { reviews: 0, lessons: 0 }]));
            const dayBounds = days.map(d => ({
                dateKey: d.dateKey,
                start: new Date(d.startISO).getTime(),
                end: new Date(d.endISO).getTime(),
            }));
            for (const it of items) {
                const updatedAt = new Date(it.data_updated_at).getTime();
                const startedAt = new Date(it.started_at).getTime();

                // Lessons bucket by started_at: it's stamped once when the
                // lesson is completed and never moves. Bucketing lessons by
                // data_updated_at (the old behavior) silently dropped them —
                // the item's first reviews re-stamp data_updated_at onto a
                // later day, so any recomputation after that reclassified the
                // lesson as a review on the wrong day and wrote 0 lessons.
                for (const d of dayBounds) {
                    if (startedAt >= d.start && startedAt < d.end) {
                        byDay.get(d.dateKey).lessons++;
                        break;
                    }
                }

                // Reviews: item updated during the day, started before it.
                const sec = Math.floor(updatedAt / 1000);
                if (perSecondCounts.get(sec) > BULK_UPDATE_SECOND_THRESHOLD) {
                    bulkFiltered++;
                    continue;
                }
                for (const d of dayBounds) {
                    if (updatedAt >= d.start && updatedAt < d.end) {
                        if (startedAt < d.start) byDay.get(d.dateKey).reviews++;
                        break;
                    }
                }
            }
            if (bulkFiltered > 0) {
                console.warn(
                    `[scheduler] filtered ${bulkFiltered} bulk-updated assignments for user ${row.discord_user_id} (likely vacation toggle)`
                );
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
            await writeReviewStatSnapshots(row.wanikani_user_id, today);

            await db.run(
                `DELETE FROM review_stat_snapshots
                 WHERE wanikani_user_id = ? AND snapshot_date < ?`,
                [row.wanikani_user_id, botDateStr(-14, timeZone)]
            );
        } catch (err) {
            console.error(`[snapshot] ${row.discord_user_id}@${guildId}:`, err);
        }
    }
}

// Per-account variant called from the 5-minute summaryRefreshJob. Looks up
// every guild this user belongs to and runs updateSnapshotsAndStreaks against
// it, so a user's heatmap and streak come alive within minutes of a review
// rather than waiting for the nightly daily job.
async function updateSnapshotsAndStreaksForAccount(account, options = {}) {
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
        await updateSnapshotsAndStreaks(m.guild_id, [row], options);
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

    // Streak-risk check ~2 hours before the bot-day rollover so users get a
    // nudge with time left to do at least one review.
    addJob(guildId, cron.schedule(
        cronExpr(shiftTime(settings.daily_summary_time, -2)),
        () => streakRiskJob(client, guildId).catch(err => console.error('[streakRiskJob]', err)),
        { timezone: tz }
    ));
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
    // WK reviews unlock on the hour. The */5 cron above does hit :00, but if
    // the per-account setTimeout misfires (bot restart, sync error, or a stale
    // /summary response) the next catchup wouldn't run until :05. This second
    // job at HH:00 backstops the timer so users get pinged within seconds of
    // the unlock instead of up to 5 minutes later.
    if (!hourlyReviewCatchupJobHandle) {
        hourlyReviewCatchupJobHandle = cron.schedule(
            '0 * * * *',
            () => hourlyReviewCatchupJob(client).catch(err => console.error('[hourlyReviewCatchupJob]', err)),
            { timezone: 'UTC' }
        );
    }
    // Level-up / reset detection (hourly — not time-critical).
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
    streakRiskJob,
    updateSnapshotsAndStreaks,
    updateSnapshotsAndStreaksForAccount,
    botDateStr,
    utcDateStr,
};
