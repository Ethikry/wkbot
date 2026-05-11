const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { isModerator } = require('../helpers/permissions');
const { success, error, base } = require('../helpers/embeds');
const { rescheduleGuild } = require('../scheduler');
const { DEFAULT_TIME_ZONE, isValidTimeZone, normalizeTimeZone, resolveTimeZone } = require('../helpers/botTime');
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
    await db.run(
        `INSERT OR IGNORE INTO guild_settings (guild_id, timezone) VALUES (?, ?)`,
        [guildId, DEFAULT_TIME_ZONE]
    );
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
            o.setName('daily').setDescription('Daily summary post: true=enable, false=disable'))
        .addBooleanOption(o =>
            o.setName('weekly').setDescription('Weekly leaderboard: true=enable, false=disable'))
        .addStringOption(o =>
            o.setName('weekly_day').setDescription('Day of week for weekly leaderboard')
                .addChoices(...DAY_NAMES.map(n => ({ name: n, value: n.toLowerCase() }))))
        .addStringOption(o =>
            o.setName('time').setDescription('Time for all scheduled messages (HH:MM, in server timezone)'))
        .addStringOption(o =>
            o.setName('timezone').setDescription('IANA timezone (Asia/Tokyo) or abbreviation (JST, PST, MDT)'))
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
        const daily = interaction.options.getBoolean('daily');
        const weekly = interaction.options.getBoolean('weekly');
        const weeklyDay = interaction.options.getString('weekly_day');
        const time = interaction.options.getString('time');
        const timezone = interaction.options.getString('timezone');
        const channel = interaction.options.getChannel('channel');
        const modrole = interaction.options.getRole('modrole');

        const noneSet = [burn, levelup, daily, weekly, weeklyDay, time, timezone, channel, modrole]
            .every(v => v === null);

        if (noneSet) {
            return showSettings(interaction, guildId);
        }

        if (time !== null && !VALID_TIME.test(time)) {
            return interaction.reply({
                embeds: [error('Invalid time', 'Use 24-hour `HH:MM` in the server timezone, e.g. `00:00`.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        const normalizedTimezone = timezone !== null ? normalizeTimeZone(timezone) : null;
        if (timezone !== null && !isValidTimeZone(normalizedTimezone)) {
            return interaction.reply({
                embeds: [error('Invalid timezone', 'Use an IANA timezone like `Asia/Tokyo`, `America/Denver`, or `Europe/London` — or an abbreviation like `JST`, `PST`, or `MDT`.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        const fields = [];
        const params = [];
        const summary = [];
        let scheduleChanged = false;

        if (burn !== null) {
            fields.push('burn_celebrations_enabled = ?');
            params.push(burn ? 1 : 0);
            summary.push(`Burn celebrations: **${burn ? 'on' : 'off'}**`);
        }
        if (levelup !== null) {
            fields.push('level_up_announcements_enabled = ?');
            params.push(levelup ? 1 : 0);
            summary.push(`Level-up announcements: **${levelup ? 'on' : 'off'}**`);
        }
        if (daily !== null) {
            fields.push('daily_summary_enabled = ?');
            params.push(daily ? 1 : 0);
            summary.push(`Daily summary: **${daily ? 'on' : 'off'}**`);
            scheduleChanged = true;
        }
        if (time !== null) {
            fields.push('daily_summary_time = ?', 'weekly_leaderboard_time = ?');
            params.push(time, time);
            summary.push(`Scheduled message time: **${time}** (server timezone)`);
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
        if (timezone !== null) {
            fields.push('timezone = ?');
            params.push(normalizedTimezone);
            summary.push(`Timezone: **${normalizedTimezone}**`);
            scheduleChanged = true;
        }
        if (channel !== null) {
            fields.push('announcement_channel_id = ?');
            params.push(channel.id);
            summary.push(`Output channel: <#${channel.id}>`);
            scheduleChanged = true;
        }
        if (modrole !== null) {
            fields.push('mod_role_id = ?');
            params.push(modrole.id);
            summary.push(`Mod role: <@&${modrole.id}>`);
        }

        fields.push('updated_at = CURRENT_TIMESTAMP');
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
    const channelStr = s.announcement_channel_id
        ? `<#${s.announcement_channel_id}>`
        : '*(not set — falls back to channel named 日本語上手 if present)*';
    const modRoleStr = s.mod_role_id
        ? `<@&${s.mod_role_id}>`
        : '*(not set — admins / Manage Server only)*';

    const embed = base('⚙️ Server Settings')
        .addFields(
            { name: 'Output channel', value: channelStr, inline: false },
            { name: 'Timezone', value: `**${resolveTimeZone(s.timezone)}**`, inline: true },
            { name: 'Scheduled time', value: `**${s.daily_summary_time}** ${resolveTimeZone(s.timezone)}`, inline: true },
            {
                name: 'Daily summary',
                value: s.daily_summary_enabled ? 'on' : 'off',
                inline: true,
            },
            {
                name: 'Weekly leaderboard',
                value: s.weekly_leaderboard_enabled
                    ? `on, **${dayName(s.weekly_leaderboard_day)}**`
                    : 'off',
                inline: true,
            },
            { name: 'Mod role', value: modRoleStr, inline: false },
            { name: 'Level-up announcements', value: s.level_up_announcements_enabled ? 'on' : 'off', inline: true },
            { name: 'Burn celebrations', value: s.burn_celebrations_enabled ? 'on' : 'off', inline: true },
        );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
