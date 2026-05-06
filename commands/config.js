const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { isModerator } = require('../helpers/permissions');
const { success, error, base } = require('../helpers/embeds');
const { rescheduleGuild } = require('../scheduler');
const db = require('../db');

const VALID_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_NAME_TO_INT = Object.fromEntries(DAY_NAMES.map((name, i) => [name.toLowerCase(), i]));

const OUTPUT_CHANNEL_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

function dayName(n) {
    return DAY_NAMES[n] ?? '?';
}

async function ensureSettings(guildId) {
    await db.run(`INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)`, [guildId]);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Configure server-wide WaniKani bot settings (mods only). Run with no options to view current.')
        .setDMPermission(false)
        .addBooleanOption(o =>
            o.setName('burn').setDescription('Burn-celebration announcements: true=enable, false=disable'))
        .addBooleanOption(o =>
            o.setName('levelup').setDescription('Level-up announcements: true=enable, false=disable'))
        .addBooleanOption(o =>
            o.setName('reviews_cleared').setDescription('Reviews-cleared celebration: true=enable, false=disable'))
        .addBooleanOption(o =>
            o.setName('daily').setDescription('Daily summary post: true=enable, false=disable'))
        .addStringOption(o =>
            o.setName('daily_time').setDescription('Daily summary time, HH:MM 24h'))
        .addBooleanOption(o =>
            o.setName('weekly').setDescription('Weekly leaderboard: true=enable, false=disable'))
        .addStringOption(o =>
            o.setName('weekly_day').setDescription('Day of week for weekly leaderboard')
                .addChoices(...DAY_NAMES.map(n => ({ name: n, value: n.toLowerCase() }))))
        .addStringOption(o =>
            o.setName('weekly_time').setDescription('Weekly leaderboard time, HH:MM 24h'))
        .addChannelOption(o =>
            o.setName('channel').setDescription('Output channel or thread for bot posts')
                .addChannelTypes(...OUTPUT_CHANNEL_TYPES))
        .addRoleOption(o =>
            o.setName('modrole').setDescription('Role allowed to run /config')),

    async execute(interaction, client) {
        if (!(await isModerator(interaction))) {
            return interaction.reply({
                embeds: [error('Forbidden', 'You need the configured mod role, or Manage Server permission, to run this.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        const guildId = interaction.guild.id;
        await ensureSettings(guildId);

        const burn = interaction.options.getBoolean('burn');
        const levelup = interaction.options.getBoolean('levelup');
        const reviewsCleared = interaction.options.getBoolean('reviews_cleared');
        const daily = interaction.options.getBoolean('daily');
        const dailyTime = interaction.options.getString('daily_time');
        const weekly = interaction.options.getBoolean('weekly');
        const weeklyDay = interaction.options.getString('weekly_day');
        const weeklyTime = interaction.options.getString('weekly_time');
        const channel = interaction.options.getChannel('channel');
        const modrole = interaction.options.getRole('modrole');

        const noneSet = [burn, levelup, reviewsCleared, daily, dailyTime, weekly, weeklyDay, weeklyTime, channel, modrole]
            .every(v => v === null);

        if (noneSet) {
            return showSettings(interaction, guildId);
        }

        if (dailyTime !== null && !VALID_TIME.test(dailyTime)) {
            return interaction.reply({
                embeds: [error('Invalid daily_time', 'Use 24-hour `HH:MM`, e.g. `15:00`.')],
                flags: MessageFlags.Ephemeral,
            });
        }
        if (weeklyTime !== null && !VALID_TIME.test(weeklyTime)) {
            return interaction.reply({
                embeds: [error('Invalid weekly_time', 'Use 24-hour `HH:MM`, e.g. `20:00`.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        const fields = [];
        const params = [];
        const summary = [];
        let scheduleChanged = false;

        if (burn !== null) {
            fields.push('burn_celebrations = ?');
            params.push(burn ? 1 : 0);
            summary.push(`Burn celebrations: **${burn ? 'on' : 'off'}**`);
        }
        if (levelup !== null) {
            fields.push('level_up_announcements = ?');
            params.push(levelup ? 1 : 0);
            summary.push(`Level-up announcements: **${levelup ? 'on' : 'off'}**`);
        }
        if (reviewsCleared !== null) {
            fields.push('reviews_cleared_announcements = ?');
            params.push(reviewsCleared ? 1 : 0);
            summary.push(`Reviews-cleared celebrations: **${reviewsCleared ? 'on' : 'off'}**`);
        }
        if (daily !== null) {
            fields.push('daily_enabled = ?');
            params.push(daily ? 1 : 0);
            summary.push(`Daily summary: **${daily ? 'on' : 'off'}**`);
            scheduleChanged = true;
        }
        if (dailyTime !== null) {
            fields.push('daily_time = ?');
            params.push(dailyTime);
            summary.push(`Daily summary time: **${dailyTime}**`);
            scheduleChanged = true;
        }
        if (weekly !== null) {
            fields.push('weekly_leaderboard_enabled = ?');
            params.push(weekly ? 1 : 0);
            summary.push(`Weekly leaderboard: **${weekly ? 'on' : 'off'}**`);
            scheduleChanged = true;
        }
        if (weeklyDay !== null) {
            fields.push('weekly_leaderboard_day = ?');
            params.push(DAY_NAME_TO_INT[weeklyDay]);
            summary.push(`Weekly leaderboard day: **${weeklyDay[0].toUpperCase() + weeklyDay.slice(1)}**`);
            scheduleChanged = true;
        }
        if (weeklyTime !== null) {
            fields.push('weekly_leaderboard_time = ?');
            params.push(weeklyTime);
            summary.push(`Weekly leaderboard time: **${weeklyTime}**`);
            scheduleChanged = true;
        }
        if (channel !== null) {
            fields.push('channel_id = ?');
            params.push(channel.id);
            summary.push(`Output channel: <#${channel.id}>`);
            scheduleChanged = true;
        }
        if (modrole !== null) {
            fields.push('mod_role_id = ?');
            params.push(modrole.id);
            summary.push(`Mod role: <@&${modrole.id}>`);
        }

        params.push(guildId);
        await db.run(
            `UPDATE guild_settings SET ${fields.join(', ')} WHERE guild_id = ?`,
            params
        );

        if (scheduleChanged) await rescheduleGuild(client, guildId);

        return interaction.reply({
            embeds: [success('Settings Updated', summary.join('\n'))],
            flags: MessageFlags.Ephemeral,
        });
    },
};

async function showSettings(interaction, guildId) {
    const s = await db.get(`SELECT * FROM guild_settings WHERE guild_id = ?`, [guildId]);
    const channelStr = s.channel_id
        ? `<#${s.channel_id}>`
        : '*(not set — falls back to channel named 日本語上手 if present)*';
    const modRoleStr = s.mod_role_id
        ? `<@&${s.mod_role_id}>`
        : '*(not set — admins / Manage Server only)*';

    const embed = base('⚙️ Server Settings')
        .addFields(
            { name: 'Output channel', value: channelStr, inline: false },
            {
                name: 'Daily summary',
                value: s.daily_enabled ? `on at **${s.daily_time}** UTC` : 'off',
                inline: true,
            },
            {
                name: 'Weekly leaderboard',
                value: s.weekly_leaderboard_enabled
                    ? `on, **${dayName(s.weekly_leaderboard_day)} ${s.weekly_leaderboard_time}** UTC`
                    : 'off',
                inline: true,
            },
            { name: 'Mod role', value: modRoleStr, inline: false },
            { name: 'Level-up announcements', value: s.level_up_announcements ? 'on' : 'off', inline: true },
            { name: 'Burn celebrations', value: s.burn_celebrations ? 'on' : 'off', inline: true },
            { name: 'Reviews-cleared celebrations', value: s.reviews_cleared_announcements ? 'on' : 'off', inline: true },
        );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
