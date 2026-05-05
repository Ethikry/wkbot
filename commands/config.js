const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { isModerator } = require('../helpers/permissions');
const { success, error, base } = require('../helpers/embeds');
const { rescheduleGuild } = require('../scheduler');
const db = require('../db');

const VALID_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

function isValidTimezone(tz) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

async function ensureSettings(guildId) {
    await db.run(`INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)`, [guildId]);
}

function ephemeral(interaction, embed) {
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function modGuard(interaction) {
    if (await isModerator(interaction)) return true;
    await ephemeral(
        interaction,
        error('Forbidden', 'You need the configured mod role, or Manage Server permission, to run this.')
    );
    return false;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Configure server-wide WaniKani bot settings (mods only)')
        .setDMPermission(false)
        .addSubcommand(s =>
            s.setName('show').setDescription('Show current settings'))
        .addSubcommand(s =>
            s.setName('channel')
                .setDescription('Set the bot output channel or thread')
                .addChannelOption(o => o.setName('channel')
                    .setDescription('Text channel, announcement channel, or thread')
                    .addChannelTypes(...OUTPUT_CHANNEL_TYPES)
                    .setRequired(true)))
        .addSubcommand(s =>
            s.setName('timezone')
                .setDescription('Set IANA timezone for all schedules')
                .addStringOption(o => o.setName('tz')
                    .setDescription('e.g. America/New_York, Europe/London, Asia/Tokyo')
                    .setRequired(true)))
        .addSubcommand(s =>
            s.setName('modrole')
                .setDescription('Set the role allowed to run /config')
                .addRoleOption(o => o.setName('role').setDescription('Mod role').setRequired(true)))
        .addSubcommand(s =>
            s.setName('daily')
                .setDescription('Set the daily summary time')
                .addStringOption(o => o.setName('time')
                    .setDescription('HH:MM in 24-hour format')
                    .setRequired(true)))
        .addSubcommand(s =>
            s.setName('morning')
                .setDescription('Toggle the morning ping')
                .addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true))
                .addStringOption(o => o.setName('time').setDescription('HH:MM 24h')))
        .addSubcommand(s =>
            s.setName('shame')
                .setDescription('Toggle end-of-day shame mode (pings users with pending reviews)')
                .addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true))
                .addStringOption(o => o.setName('time').setDescription('HH:MM 24h')))
        .addSubcommand(s =>
            s.setName('leaderboard')
                .setDescription('Toggle the weekly auto-leaderboard')
                .addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true))
                .addIntegerOption(o => o.setName('day')
                    .setDescription('Day of week (0=Sun, 6=Sat)')
                    .setMinValue(0).setMaxValue(6))
                .addStringOption(o => o.setName('time').setDescription('HH:MM 24h')))
        .addSubcommand(s =>
            s.setName('levelups')
                .setDescription('Toggle level-up announcements')
                .addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true)))
        .addSubcommand(s =>
            s.setName('burns')
                .setDescription('Toggle burn-celebration announcements')
                .addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true))),

    async execute(interaction, client) {
        if (!(await modGuard(interaction))) return;

        const guildId = interaction.guild.id;
        await ensureSettings(guildId);
        const sub = interaction.options.getSubcommand();

        switch (sub) {
            case 'show': return showSettings(interaction, guildId);
            case 'channel': return setChannel(interaction, client, guildId);
            case 'timezone': return setTimezone(interaction, client, guildId);
            case 'modrole': return setModRole(interaction, guildId);
            case 'daily': return setDaily(interaction, client, guildId);
            case 'morning': return setMorning(interaction, client, guildId);
            case 'shame': return setShame(interaction, client, guildId);
            case 'leaderboard': return setLeaderboard(interaction, client, guildId);
            case 'levelups': return setBoolFlag(interaction, guildId, 'level_up_announcements', 'Level-up announcements');
            case 'burns': return setBoolFlag(interaction, guildId, 'burn_celebrations', 'Burn celebrations');
        }
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
            { name: 'Daily summary', value: `${s.daily_time} ${s.timezone}`, inline: true },
            { name: 'Morning ping', value: s.morning_ping_enabled ? `${s.morning_time} ${s.timezone}` : 'off', inline: true },
            { name: 'Shame mode', value: s.shame_mode_enabled ? `${s.shame_time} ${s.timezone}` : 'off', inline: true },
            {
                name: 'Weekly leaderboard',
                value: s.weekly_leaderboard_enabled
                    ? `${dayName(s.weekly_leaderboard_day)} ${s.weekly_leaderboard_time} ${s.timezone}`
                    : 'off',
                inline: false,
            },
            { name: 'Mod role', value: modRoleStr, inline: false },
            { name: 'Level-up announcements', value: s.level_up_announcements ? 'on' : 'off', inline: true },
            { name: 'Burn celebrations', value: s.burn_celebrations ? 'on' : 'off', inline: true },
        );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function setChannel(interaction, client, guildId) {
    const ch = interaction.options.getChannel('channel');
    await db.run(`UPDATE guild_settings SET channel_id = ? WHERE guild_id = ?`, [ch.id, guildId]);
    await rescheduleGuild(client, guildId);
    return ephemeral(interaction, success('Channel Updated', `Bot output now goes to <#${ch.id}>.`));
}

async function setDaily(interaction, client, guildId) {
    const time = interaction.options.getString('time');
    if (!VALID_TIME.test(time)) {
        return ephemeral(interaction, error('Invalid Time', 'Use 24-hour `HH:MM`, e.g. `15:00`.'));
    }
    await db.run(`UPDATE guild_settings SET daily_time = ? WHERE guild_id = ?`, [time, guildId]);
    await rescheduleGuild(client, guildId);
    return ephemeral(interaction, success('Daily Time Updated', `Daily summary will run at ${time}.`));
}

async function setTimezone(interaction, client, guildId) {
    const tz = interaction.options.getString('tz');
    if (!isValidTimezone(tz)) {
        return ephemeral(interaction, error('Invalid Timezone', 'Use an IANA timezone (e.g. `America/New_York`, `Europe/London`).'));
    }
    await db.run(`UPDATE guild_settings SET timezone = ? WHERE guild_id = ?`, [tz, guildId]);
    await rescheduleGuild(client, guildId);
    return ephemeral(interaction, success('Timezone Updated', `Schedules now use **${tz}**.`));
}

async function setMorning(interaction, client, guildId) {
    const enabled = interaction.options.getBoolean('enabled') ? 1 : 0;
    const time = interaction.options.getString('time');
    if (time && !VALID_TIME.test(time)) {
        return ephemeral(interaction, error('Invalid Time', 'Use 24-hour `HH:MM`.'));
    }
    if (time) {
        await db.run(
            `UPDATE guild_settings SET morning_ping_enabled = ?, morning_time = ? WHERE guild_id = ?`,
            [enabled, time, guildId]
        );
    } else {
        await db.run(
            `UPDATE guild_settings SET morning_ping_enabled = ? WHERE guild_id = ?`,
            [enabled, guildId]
        );
    }
    await rescheduleGuild(client, guildId);
    return ephemeral(
        interaction,
        success('Morning Ping Updated', `Morning ping ${enabled ? `enabled${time ? ` at ${time}` : ''}` : 'disabled'}.`)
    );
}

async function setShame(interaction, client, guildId) {
    const enabled = interaction.options.getBoolean('enabled') ? 1 : 0;
    const time = interaction.options.getString('time');
    if (time && !VALID_TIME.test(time)) {
        return ephemeral(interaction, error('Invalid Time', 'Use 24-hour `HH:MM`.'));
    }
    if (time) {
        await db.run(
            `UPDATE guild_settings SET shame_mode_enabled = ?, shame_time = ? WHERE guild_id = ?`,
            [enabled, time, guildId]
        );
    } else {
        await db.run(
            `UPDATE guild_settings SET shame_mode_enabled = ? WHERE guild_id = ?`,
            [enabled, guildId]
        );
    }
    await rescheduleGuild(client, guildId);
    return ephemeral(
        interaction,
        success('Shame Mode Updated', `Shame mode ${enabled ? `enabled${time ? ` at ${time}` : ''}` : 'disabled'}.`)
    );
}

async function setLeaderboard(interaction, client, guildId) {
    const enabled = interaction.options.getBoolean('enabled') ? 1 : 0;
    const day = interaction.options.getInteger('day');
    const time = interaction.options.getString('time');
    if (time && !VALID_TIME.test(time)) {
        return ephemeral(interaction, error('Invalid Time', 'Use 24-hour `HH:MM`.'));
    }
    const fields = ['weekly_leaderboard_enabled = ?'];
    const params = [enabled];
    if (day !== null) { fields.push('weekly_leaderboard_day = ?'); params.push(day); }
    if (time) { fields.push('weekly_leaderboard_time = ?'); params.push(time); }
    params.push(guildId);
    await db.run(
        `UPDATE guild_settings SET ${fields.join(', ')} WHERE guild_id = ?`,
        params
    );
    await rescheduleGuild(client, guildId);

    const detail = enabled
        ? `Weekly leaderboard enabled${day !== null ? ` on ${dayName(day)}` : ''}${time ? ` at ${time}` : ''}.`
        : 'Weekly leaderboard disabled.';
    return ephemeral(interaction, success('Weekly Leaderboard Updated', detail));
}

async function setModRole(interaction, guildId) {
    const role = interaction.options.getRole('role');
    await db.run(`UPDATE guild_settings SET mod_role_id = ? WHERE guild_id = ?`, [role.id, guildId]);
    return ephemeral(interaction, success('Mod Role Updated', `<@&${role.id}> can now run \`/config\`.`));
}

async function setBoolFlag(interaction, guildId, column, label) {
    const enabled = interaction.options.getBoolean('enabled') ? 1 : 0;
    await db.run(`UPDATE guild_settings SET ${column} = ? WHERE guild_id = ?`, [enabled, guildId]);
    return ephemeral(interaction, success(`${label} ${enabled ? 'Enabled' : 'Disabled'}`, `${label} ${enabled ? 'enabled' : 'disabled'}.`));
}
