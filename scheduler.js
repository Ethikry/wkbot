const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { decrypt } = require('./helpers/crypto');
const {
    wkFetch,
    fetchAllPages,
    getWaniKaniData,
    getReviewsCompletedSince,
    getLessonsCompletedSince,
    getBurnedCount,
    getResetsSince,
    clearCacheForApiKey,
} = require('./helpers/wanikaniData');
const { COLOR_PRIMARY, COLOR_ERROR, COLOR_WARN, COLOR_SUCCESS, FOOTER } = require('./helpers/embeds');
const { recordPoll, evaluateAllGoal } = require('./helpers/zerostate');
const { pickShameLine } = require('./helpers/shame');

const guildJobs = new Map();
let pollJob = null;
let paceAlertJobHandle = null;

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;
const REVIEWS_AVAILABLE_DM_THRESHOLD = 50;
const MIDNIGHT_UTC_TODAY = () => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
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

function isValidTimezone(tz) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

async function getOrCreateSettings(guildId) {
    await db.run(`INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)`, [guildId]);
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
            const apiKey = decrypt(row.api_token_encrypted);
            const data = await getWaniKaniData(apiKey);
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
        .setDescription(description)
        .setTimestamp()
        .setFooter(FOOTER);

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

async function appendGoalProgress(guildId, guild, embed) {
    const rows = await db.all(
        `SELECT
             gm.discord_user_id,
             COALESCE(rs.shame_enabled, 0) AS shame_enabled,
             COALESCE(g.daily_lessons, lg.daily_lessons, 0) AS daily_lessons,
             COALESCE(g.daily_all_lessons, 0) AS daily_all_lessons,
             COALESCE(g.daily_reviews, lg.daily_reviews, 0) AS daily_reviews,
             COALESCE(g.daily_all_reviews, 0) AS daily_all_reviews,
             CASE WHEN g.discord_user_id IS NOT NULL THEN 'local' ELSE 'long' END AS source
         FROM guild_members gm
         LEFT JOIN goals g
             ON g.guild_id = gm.guild_id AND g.discord_user_id = gm.discord_user_id
         LEFT JOIN long_goals lg ON lg.discord_user_id = gm.discord_user_id
         LEFT JOIN reminder_settings rs
             ON rs.guild_id = gm.guild_id AND rs.discord_user_id = gm.discord_user_id
         WHERE gm.guild_id = ?
           AND (g.discord_user_id IS NOT NULL OR lg.discord_user_id IS NOT NULL)`,
        [guildId]
    );
    const today = utcDateStr();
    const lines = [];

    for (const g of rows) {
        const hasLesson = (g.daily_lessons || 0) > 0;
        const hasLessonsAll = g.daily_all_lessons === 1;
        const hasReview = (g.daily_reviews || 0) > 0;
        const hasAll = g.daily_all_reviews === 1;
        if (!hasLesson && !hasLessonsAll && !hasReview && !hasAll) continue;

        const member = await guild.members.fetch(g.discord_user_id).catch(() => null);
        if (!member) continue;
        const name = member.displayName;

        const snap = await db.get(
            `SELECT reviews_completed, lessons_completed FROM daily_snapshots
             WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date = ?`,
            [guildId, g.discord_user_id, today]
        );
        const r = snap?.reviews_completed ?? 0;
        const l = snap?.lessons_completed ?? 0;
        const lOk = !hasLesson || l >= g.daily_lessons;
        const rOk = !hasReview || r >= g.daily_reviews;

        let allOk = true;
        let allLabel = null;
        if (hasAll) {
            const result = await evaluateAllGoal(g.discord_user_id, guildId, r);
            allOk = result.ok;
            allLabel = formatAllGoalLabel(result);
        }

        const fullSuccess = lOk && rOk && allOk;
        const icon = fullSuccess ? '✅' : '⏳';
        const sourceTag = g.source === 'long' ? ' 🎯' : '';
        const parts = [];
        if (hasLessonsAll) parts.push(`${l} lessons (all)`);
        else if (hasLesson) parts.push(`${l}/${g.daily_lessons} lessons`);
        if (hasReview) parts.push(`${r}/${g.daily_reviews} reviews`);
        if (allLabel) parts.push(allLabel);

        let line = `${icon} **${name}**${sourceTag} — ${parts.join(' · ')}`;
        if (!fullSuccess && g.shame_enabled === 1) {
            line += `\n  💢 _${pickShameLine()}_`;
        }
        lines.push(line);
    }

    if (lines.length) {
        embed.addFields({ name: '🎯 Goal Progress', value: lines.join('\n') });
    }
}

function formatAllGoalLabel(result) {
    switch (result.reason) {
        case 'cleared': return 'queue cleared 🧹';
        case 'kept_up': return 'queue kept up 📈';
        case 'no_reviews': return 'queue pending';
        case 'queue_grew': return 'queue grew 📉';
        case 'insufficient_history': return 'queue tracking…';
        default: return 'queue pending';
    }
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
            const embed = summaryEmbed('📅 Daily WaniKani Summary', "Today's status:", summaries);
            await appendGoalProgress(guildId, guild, embed);

            const pingList = summaries.filter(s => s.ping).map(s => `<@${s.userId}>`);
            await channel.send({
                content: pingList.length ? pingList.join(' ') : undefined,
                embeds: [embed],
            });
        }
    }

    await updateSnapshotsAndStreaks(guildId, rows);
}

async function leaderboardJob(client, guildId) {
    console.log(`[leaderboard] guild=${guildId}`);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const settings = await getOrCreateSettings(guildId);
    const channel = await resolveOutputChannel(guild, settings);
    if (!channel) return;

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 7);
    const sinceStr = since.toISOString().slice(0, 10);

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

    const shameTargets = enriched.filter(e => e.shameEnabled && e.reviews === 0);
    const shameBlock = shameTargets.length
        ? `\n\n**🥶 Shame Corner**\n` + shameTargets.map(e => `<@${e.userId}> — _${pickShameLine()}_`).join('\n')
        : '';

    const embed = new EmbedBuilder()
        .setColor(COLOR_PRIMARY)
        .setTitle('🏆 Weekly Leaderboard')
        .setDescription(clipDescription(lines.join('\n') + shameBlock))
        .setTimestamp()
        .setFooter({ text: 'Past 7 days · WaniKani Bot' });

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

async function pollUsersJob(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            const settings = await getOrCreateSettings(guild.id);
            const channel = await resolveOutputChannel(guild, settings);

            const rows = await getGuildMembers(guild.id);

            for (const row of rows) {
                try {
                    const apiKey = decrypt(row.api_token_encrypted);
                    const data = await getWaniKaniData(apiKey);
                    const level = data.userData.level;
                    const dueRightNow = data.dueRightNow;
                    const burned = settings.burn_celebrations_enabled
                        ? await getBurnedCount(apiKey).catch(() => null)
                        : null;

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

                    if (cleared) {
                        try {
                            const reviewsToday = await getReviewsCompletedSince(apiKey, MIDNIGHT_UTC_TODAY())
                                .catch(() => null);
                            const description = reviewsToday !== null
                                ? `<@${row.discord_user_id}> just cleared their review queue — **${reviewsToday}** reviews done today!`
                                : `<@${row.discord_user_id}> just cleared their review queue — nice!`;
                            const embed = new EmbedBuilder()
                                .setColor(COLOR_SUCCESS)
                                .setTitle('🧹 Reviews cleared!')
                                .setDescription(description)
                                .setTimestamp()
                                .setFooter(FOOTER);
                            await channel.send({ content: `<@${row.discord_user_id}>`, embeds: [embed] });
                            await db.run(
                                `INSERT INTO bot_user_state (guild_id, discord_user_id, wanikani_user_id, last_reviews_cleared_at)
                                 VALUES (?, ?, ?, ?)
                                 ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
                                     last_reviews_cleared_at = excluded.last_reviews_cleared_at,
                                     updated_at = CURRENT_TIMESTAMP`,
                                [guild.id, row.discord_user_id, row.wanikani_user_id, new Date().toISOString()]
                            );
                        } catch (err) {
                            console.error(`[poll/cleared] ${row.discord_user_id}@${guild.id}:`, err.message);
                        }
                    }

                    // Level-up: compare against the level we last persisted on wanikani_accounts.
                    const account = await db.get(
                        `SELECT level FROM wanikani_accounts WHERE wanikani_user_id = ?`,
                        [row.wanikani_user_id]
                    );
                    const previousLevel = account?.level ?? null;
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

                    // Burn-delta: compare to in-memory cached count from a previous tick this process.
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

                    // Persist the latest level + vacation status on the WK account row.
                    await db.run(
                        `UPDATE wanikani_accounts
                         SET level = ?,
                             current_vacation_started_at = ?,
                             last_user_sync_at = CURRENT_TIMESTAMP,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE wanikani_user_id = ?`,
                        [level, data.userData.current_vacation_started_at ?? null, row.wanikani_user_id]
                    );

                    await maybeSendReviewsAvailableDM(client, row.discord_user_id, dueRightNow);
                } catch (err) {
                    console.error(`[poll] ${row.discord_user_id}@${guild.id}:`, err.message);
                }
            }
        } catch (err) {
            console.error('[poll] guild loop:', err);
        }
    }
}

async function maybeSendReviewsAvailableDM(client, discordUserId, dueRightNow) {
    if (dueRightNow <= 0) return;
    const goal = await db.get(
        `SELECT notify_enabled, last_alerted_at, target_level, deadline
         FROM long_goals WHERE discord_user_id = ?`,
        [discordUserId]
    );
    if (!goal || goal.notify_enabled !== 1) return;
    if (dueRightNow < REVIEWS_AVAILABLE_DM_THRESHOLD) return;
    if (goal.last_alerted_at) {
        const ageMs = Date.now() - new Date(goal.last_alerted_at).getTime();
        if (ageMs >= 0 && ageMs < FOUR_HOURS_MS) return;
    }

    const user = await client.users.fetch(discordUserId).catch(() => null);
    if (!user) return;

    const embed = new EmbedBuilder()
        .setColor(COLOR_PRIMARY)
        .setTitle('📚 Reviews piling up')
        .setDescription([
            `You have **${dueRightNow}** reviews due (alert kicks in at ${REVIEWS_AVAILABLE_DM_THRESHOLD}).`,
            `Goal: level ${goal.target_level}${goal.deadline ? ` by ${goal.deadline}` : ''}.`,
            '',
            'Disable with `/goals` → Configure alerts.',
        ].join('\n'))
        .setTimestamp()
        .setFooter(FOOTER);

    try {
        await user.send({ embeds: [embed] });
        await db.run(
            `UPDATE long_goals SET last_alerted_at = ?, updated_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?`,
            [new Date().toISOString(), discordUserId]
        );
    } catch (err) {
        console.warn(`[reviewDM] ${discordUserId}: ${err.message}`);
    }
}

async function paceAlertJob(client) {
    const goals = await db.all(`SELECT * FROM long_goals WHERE notify_enabled = 1`);
    const today = utcDateStr();

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
                const snap = await db.get(
                    `SELECT lessons_completed FROM daily_snapshots
                     WHERE guild_id = ? AND discord_user_id = ? AND snapshot_date = ?`,
                    [m.guild_id, goal.discord_user_id, today]
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

async function updateSnapshotsAndStreaks(guildId, rows) {
    const today = utcDateStr();
    const yesterday = utcDateStr(-1);
    const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    for (const row of rows) {
        try {
            const apiKey = decrypt(row.api_token_encrypted);
            const [reviewsDone, lessonsDone, userJson] = await Promise.all([
                getReviewsCompletedSince(apiKey, sinceISO),
                getLessonsCompletedSince(apiKey, sinceISO),
                wkFetch('/user', apiKey),
            ]);
            const level = userJson.data.level;

            await db.run(
                `INSERT INTO daily_snapshots (
                    guild_id, discord_user_id, wanikani_user_id, snapshot_date,
                    level, reviews_completed, lessons_completed
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(guild_id, discord_user_id, snapshot_date) DO UPDATE SET
                    level = excluded.level,
                    reviews_completed = excluded.reviews_completed,
                    lessons_completed = excluded.lessons_completed`,
                [guildId, row.discord_user_id, row.wanikani_user_id, today, level, reviewsDone, lessonsDone]
            );

            const streak = await db.get(
                `SELECT current_streak, longest_streak, last_review_date FROM streaks
                 WHERE guild_id = ? AND discord_user_id = ?`,
                [guildId, row.discord_user_id]
            );

            if (reviewsDone > 0) {
                let current;
                if (!streak) current = 1;
                else if (streak.last_review_date === today) current = streak.current_streak;
                else if (streak.last_review_date === yesterday) current = streak.current_streak + 1;
                else current = 1;
                const longest = Math.max(current, streak?.longest_streak ?? 0);

                await db.run(
                    `INSERT INTO streaks (guild_id, discord_user_id, current_streak, longest_streak, last_review_date)
                     VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
                        current_streak = excluded.current_streak,
                        longest_streak = excluded.longest_streak,
                        last_review_date = excluded.last_review_date,
                        updated_at = CURRENT_TIMESTAMP`,
                    [guildId, row.discord_user_id, current, longest, today]
                );
            } else if (streak && streak.last_review_date && streak.last_review_date < yesterday) {
                await db.run(
                    `UPDATE streaks SET current_streak = 0, updated_at = CURRENT_TIMESTAMP
                     WHERE guild_id = ? AND discord_user_id = ?`,
                    [guildId, row.discord_user_id]
                );
            }

            // Snapshot review_statistics for /mistakes baselines.
            const recentStats = await fetchAllPages(
                `/review_statistics?updated_after=${encodeURIComponent(sinceISO)}`,
                apiKey
            ).catch(() => []);

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
                        row.wanikani_user_id, s.data.subject_id, today,
                        s.data.meaning_incorrect || 0,
                        s.data.reading_incorrect || 0,
                        s.data.percentage_correct || 0,
                    ]
                );
            }

            await db.run(
                `DELETE FROM review_stat_snapshots
                 WHERE wanikani_user_id = ? AND snapshot_date < date('now', '-14 days')`,
                [row.wanikani_user_id]
            );
        } catch (err) {
            console.error(`[snapshot] ${row.discord_user_id}@${guildId}:`, err.message);
        }
    }
}

function utcDateStr(dayOffset = 0) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + dayOffset);
    return d.toISOString().slice(0, 10);
}

async function scheduleGuild(client, guildId) {
    clearGuildJobs(guildId);
    const settings = await getOrCreateSettings(guildId);
    const tz = isValidTimezone(settings.timezone) ? settings.timezone : 'UTC';

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
    if (!pollJob) {
        pollJob = cron.schedule(
            '*/15 * * * *',
            () => pollUsersJob(client).catch(err => console.error('[pollUsersJob]', err)),
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
}

module.exports = {
    scheduleAll,
    scheduleGuild,
    rescheduleGuild,
    dailyJob,
    leaderboardJob,
    pollUsersJob,
    paceAlertJob,
    updateSnapshotsAndStreaks,
    utcDateStr,
};
