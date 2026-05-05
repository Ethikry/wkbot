const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { decrypt } = require('./helpers/crypto');
const {
    wkFetch,
    getWaniKaniData,
    getReviewsCompletedSince,
    getLessonsCompletedSince,
    getBurnedCount,
} = require('./helpers/wanikaniData');
const { COLOR_PRIMARY, COLOR_ERROR, COLOR_WARN, FOOTER } = require('./helpers/embeds');

const guildJobs = new Map();
let hourlyJob = null;

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
    if (settings.channel_id) {
        const cached = guild.channels.cache.get(settings.channel_id);
        if (cached?.isTextBased?.()) return cached;
        const fetched = await guild.channels.fetch(settings.channel_id).catch(() => null);
        if (fetched?.isTextBased?.()) return fetched;
    }
    const fallback = guild.channels.cache.find(
        c => c.name === '日本語上手' && c.isTextBased?.()
    );
    return fallback ?? null;
}

async function fetchUserSummaries(guild, rows) {
    return Promise.all(rows.map(async row => {
        const member = await guild.members.fetch(row.user_id).catch(() => null);
        const username = member ? (member.nickname || member.user.username) : 'Unknown';
        try {
            const apiKey = decrypt(row.api_key);
            const data = await getWaniKaniData(apiKey);
            return {
                userId: row.user_id,
                username,
                ping: row.ping_enabled === 1,
                onVacation: !!data.userData.current_vacation_started_at,
                level: data.userData.level,
                pendingLessons: data.pendingLessons,
                dueRightNow: data.dueRightNow,
                dueNext24Hours: data.dueNext24Hours,
            };
        } catch (err) {
            console.error(`[scheduler] WK fetch failed for ${row.user_id}:`, err.message);
            return {
                userId: row.user_id,
                username,
                ping: row.ping_enabled === 1,
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
                value: `Lvl **${s.level}** • Lessons **${s.pendingLessons}** • Now **${s.dueRightNow}** • Next 24h **${next24Excl}**`,
                inline: false,
            });
        }
    }
    return embed;
}

async function appendGoalProgress(guildId, guild, embed) {
    const goals = await db.all(
        `SELECT user_id, daily_lessons, daily_reviews FROM goals WHERE guild_id = ?`,
        [guildId]
    );
    const today = utcDateStr();
    const lines = [];
    for (const g of goals) {
        if ((g.daily_lessons || 0) === 0 && (g.daily_reviews || 0) === 0) continue;
        const member = await guild.members.fetch(g.user_id).catch(() => null);
        if (!member) continue;
        const name = member.nickname || member.user.username;
        const snap = await db.get(
            `SELECT reviews_completed, lessons_completed FROM daily_snapshots WHERE user_id = ? AND guild_id = ? AND date = ?`,
            [g.user_id, guildId, today]
        );
        const r = snap?.reviews_completed ?? 0;
        const l = snap?.lessons_completed ?? 0;
        const rOk = (g.daily_reviews || 0) === 0 || r >= g.daily_reviews;
        const lOk = (g.daily_lessons || 0) === 0 || l >= g.daily_lessons;
        const icon = rOk && lOk ? '✅' : '⏳';
        lines.push(`${icon} **${name}** — ${l}/${g.daily_lessons || 0} lessons · ${r}/${g.daily_reviews || 0} reviews`);
    }
    if (lines.length) {
        embed.addFields({ name: '🎯 Goal Progress', value: lines.join('\n') });
    }
}

async function dailyJob(client, guildId) {
    console.log(`[daily] guild=${guildId}`);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const settings = await getOrCreateSettings(guildId);
    const channel = await resolveOutputChannel(guild, settings);
    if (!channel) return;

    const rows = await db.all(
        `SELECT user_id, api_key, ping_enabled FROM apikeys WHERE guild_id = ?`,
        [guildId]
    );
    if (rows.length === 0) return;

    const summaries = await fetchUserSummaries(guild, rows);
    const embed = summaryEmbed('📅 Daily WaniKani Summary', "Today's status:", summaries);
    await appendGoalProgress(guildId, guild, embed);

    const pingList = summaries.filter(s => s.ping).map(s => `<@${s.userId}>`);
    await channel.send({
        content: pingList.length ? pingList.join(' ') : undefined,
        embeds: [embed],
    });

    await updateSnapshotsAndStreaks(guildId, rows);
}

async function morningJob(client, guildId) {
    console.log(`[morning] guild=${guildId}`);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const settings = await getOrCreateSettings(guildId);
    const channel = await resolveOutputChannel(guild, settings);
    if (!channel) return;

    const rows = await db.all(
        `SELECT user_id, api_key, ping_enabled FROM apikeys WHERE guild_id = ?`,
        [guildId]
    );
    if (rows.length === 0) return;

    const summaries = await fetchUserSummaries(guild, rows);
    const embed = summaryEmbed('☀️ Morning Reminder', 'Start the day with some reviews!', summaries);
    const pingList = summaries.filter(s => s.ping).map(s => `<@${s.userId}>`);
    await channel.send({
        content: pingList.length ? pingList.join(' ') : undefined,
        embeds: [embed],
    });
}

async function shameJob(client, guildId) {
    console.log(`[shame] guild=${guildId}`);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const settings = await getOrCreateSettings(guildId);
    const channel = await resolveOutputChannel(guild, settings);
    if (!channel) return;

    const rows = await db.all(
        `SELECT user_id, api_key FROM apikeys WHERE guild_id = ?`,
        [guildId]
    );
    if (rows.length === 0) return;

    const slackers = (await Promise.all(rows.map(async row => {
        try {
            const apiKey = decrypt(row.api_key);
            const data = await getWaniKaniData(apiKey);
            if (data.userData.current_vacation_started_at) return null;
            if (data.dueRightNow > 0) return { userId: row.user_id, due: data.dueRightNow };
            return null;
        } catch {
            return null;
        }
    }))).filter(Boolean);

    if (slackers.length === 0) return;

    const embed = new EmbedBuilder()
        .setColor(COLOR_WARN)
        .setTitle('⚠️ Pending Reviews')
        .setDescription(slackers.map(s => `<@${s.userId}> — **${s.due}** review${s.due === 1 ? '' : 's'} still pending`).join('\n'))
        .setTimestamp()
        .setFooter(FOOTER);

    await channel.send({
        content: slackers.map(s => `<@${s.userId}>`).join(' '),
        embeds: [embed],
    });
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
        `SELECT user_id,
                COALESCE(SUM(reviews_completed), 0) AS reviews,
                COALESCE(SUM(lessons_completed), 0) AS lessons
         FROM daily_snapshots
         WHERE guild_id = ? AND date >= ?
         GROUP BY user_id
         HAVING reviews > 0 OR lessons > 0
         ORDER BY reviews DESC, lessons DESC
         LIMIT 10`,
        [guildId, sinceStr]
    );

    if (rows.length === 0) return;

    const lines = await Promise.all(rows.map(async (r, i) => {
        const member = await guild.members.fetch(r.user_id).catch(() => null);
        const name = member ? (member.nickname || member.user.username) : 'Unknown';
        const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
        return `${medal} **${name}** — ${r.reviews} reviews · ${r.lessons} lessons`;
    }));

    const embed = new EmbedBuilder()
        .setColor(COLOR_PRIMARY)
        .setTitle('🏆 Weekly Leaderboard')
        .setDescription(lines.join('\n'))
        .setTimestamp()
        .setFooter({ text: 'Past 7 days · WaniKani Bot' });

    await channel.send({ embeds: [embed] });
}

async function hourlyMilestoneJob(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            const settings = await getOrCreateSettings(guild.id);
            if (!settings.level_up_announcements && !settings.burn_celebrations) continue;

            const channel = await resolveOutputChannel(guild, settings);
            if (!channel) continue;

            const rows = await db.all(
                `SELECT user_id, api_key FROM apikeys WHERE guild_id = ?`,
                [guild.id]
            );
            for (const row of rows) {
                try {
                    const apiKey = decrypt(row.api_key);
                    const userJson = await wkFetch('/user', apiKey);
                    const level = userJson.data.level;
                    const burned = settings.burn_celebrations ? await getBurnedCount(apiKey) : null;

                    const state = await db.get(
                        `SELECT last_known_level, last_known_burned FROM user_state WHERE user_id = ? AND guild_id = ?`,
                        [row.user_id, guild.id]
                    );

                    if (!state) {
                        await db.run(
                            `INSERT INTO user_state (user_id, guild_id, last_known_level, last_known_burned) VALUES (?, ?, ?, ?)`,
                            [row.user_id, guild.id, level, burned]
                        );
                        continue;
                    }

                    if (
                        settings.level_up_announcements &&
                        state.last_known_level !== null &&
                        level > state.last_known_level
                    ) {
                        const embed = new EmbedBuilder()
                            .setColor(COLOR_PRIMARY)
                            .setTitle('🎉 Level Up!')
                            .setDescription(`<@${row.user_id}> just reached **level ${level}**!`)
                            .setTimestamp()
                            .setFooter(FOOTER);
                        await channel.send({ content: `<@${row.user_id}>`, embeds: [embed] });
                    }

                    if (
                        settings.burn_celebrations &&
                        burned !== null &&
                        state.last_known_burned !== null &&
                        burned > state.last_known_burned
                    ) {
                        const delta = burned - state.last_known_burned;
                        const embed = new EmbedBuilder()
                            .setColor(0xE67E22)
                            .setTitle('🔥 Burned!')
                            .setDescription(`<@${row.user_id}> just burned **${delta}** item${delta === 1 ? '' : 's'} (total burned: **${burned}**)`)
                            .setTimestamp()
                            .setFooter(FOOTER);
                        await channel.send({ embeds: [embed] });
                    }

                    await db.run(
                        `UPDATE user_state
                         SET last_known_level = ?,
                             last_known_burned = COALESCE(?, last_known_burned)
                         WHERE user_id = ? AND guild_id = ?`,
                        [level, burned, row.user_id, guild.id]
                    );
                } catch (err) {
                    console.error(`[hourly] ${row.user_id}@${guild.id}:`, err.message);
                }
            }
        } catch (err) {
            console.error('[hourly] guild loop:', err);
        }
    }
}

async function updateSnapshotsAndStreaks(guildId, rows) {
    const today = utcDateStr();
    const yesterday = utcDateStr(-1);
    const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    for (const row of rows) {
        try {
            const apiKey = decrypt(row.api_key);
            const [reviewsDone, lessonsDone, userJson, burned] = await Promise.all([
                getReviewsCompletedSince(apiKey, sinceISO),
                getLessonsCompletedSince(apiKey, sinceISO),
                wkFetch('/user', apiKey),
                getBurnedCount(apiKey).catch(() => null),
            ]);
            const level = userJson.data.level;

            await db.run(
                `INSERT INTO daily_snapshots (user_id, guild_id, date, reviews_completed, lessons_completed, level, burned)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(user_id, guild_id, date) DO UPDATE SET
                   reviews_completed = excluded.reviews_completed,
                   lessons_completed = excluded.lessons_completed,
                   level = excluded.level,
                   burned = excluded.burned`,
                [row.user_id, guildId, today, reviewsDone, lessonsDone, level, burned]
            );

            const streak = await db.get(
                `SELECT current_streak, longest_streak, last_review_date FROM streaks WHERE user_id = ? AND guild_id = ?`,
                [row.user_id, guildId]
            );

            if (reviewsDone > 0) {
                let current;
                if (!streak) current = 1;
                else if (streak.last_review_date === today) current = streak.current_streak;
                else if (streak.last_review_date === yesterday) current = streak.current_streak + 1;
                else current = 1;
                const longest = Math.max(current, streak?.longest_streak ?? 0);

                if (streak) {
                    await db.run(
                        `UPDATE streaks SET current_streak = ?, longest_streak = ?, last_review_date = ? WHERE user_id = ? AND guild_id = ?`,
                        [current, longest, today, row.user_id, guildId]
                    );
                } else {
                    await db.run(
                        `INSERT INTO streaks (user_id, guild_id, current_streak, longest_streak, last_review_date) VALUES (?, ?, ?, ?, ?)`,
                        [row.user_id, guildId, current, longest, today]
                    );
                }
            } else if (streak && streak.last_review_date && streak.last_review_date < yesterday) {
                await db.run(
                    `UPDATE streaks SET current_streak = 0 WHERE user_id = ? AND guild_id = ?`,
                    [row.user_id, guildId]
                );
            }
        } catch (err) {
            console.error(`[snapshot] ${row.user_id}@${guildId}:`, err.message);
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
        cronExpr(settings.daily_time),
        () => dailyJob(client, guildId).catch(err => console.error('[dailyJob]', err)),
        { timezone: tz }
    ));

    if (settings.morning_ping_enabled) {
        addJob(guildId, cron.schedule(
            cronExpr(settings.morning_time),
            () => morningJob(client, guildId).catch(err => console.error('[morningJob]', err)),
            { timezone: tz }
        ));
    }

    if (settings.shame_mode_enabled) {
        addJob(guildId, cron.schedule(
            cronExpr(settings.shame_time),
            () => shameJob(client, guildId).catch(err => console.error('[shameJob]', err)),
            { timezone: tz }
        ));
    }

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
    if (!hourlyJob) {
        hourlyJob = cron.schedule(
            '0 * * * *',
            () => hourlyMilestoneJob(client).catch(err => console.error('[hourlyMilestoneJob]', err)),
            { timezone: 'UTC' }
        );
    }
}

module.exports = {
    scheduleAll,
    scheduleGuild,
    rescheduleGuild,
    dailyJob,
    morningJob,
    shameJob,
    leaderboardJob,
    hourlyMilestoneJob,
};
