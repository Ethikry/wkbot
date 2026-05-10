const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isModerator } = require('../helpers/permissions');
const { success, error, base } = require('../helpers/embeds');
const { rescheduleGuild } = require('../scheduler');
const db = require('../db');

function isValidTimezone(tz) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

function formatNowInTz(tz) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('timezone')
        .setDescription('View or set the bot timezone for this server (mods only).')
        .setDMPermission(false)
        .addStringOption(o =>
            o.setName('tz')
                .setDescription('IANA timezone, e.g. Asia/Tokyo, UTC, America/Los_Angeles')
                .setRequired(false)),

    async execute(interaction, client) {
        const guildId = interaction.guild.id;
        await db.run(`INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)`, [guildId]);

        const tz = interaction.options.getString('tz');

        if (tz === null) {
            const settings = await db.get(
                `SELECT timezone, daily_summary_time FROM guild_settings WHERE guild_id = ?`,
                [guildId]
            );
            const currentTz = settings?.timezone ?? 'Asia/Tokyo';
            const embed = base('🕒 Server Timezone')
                .addFields(
                    { name: 'Timezone', value: `**${currentTz}**`, inline: true },
                    { name: 'Daily reset', value: `**${settings?.daily_summary_time ?? '00:00'}** ${currentTz}`, inline: true },
                    { name: 'Now', value: formatNowInTz(currentTz), inline: false },
                );
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (!(await isModerator(interaction))) {
            return interaction.reply({
                embeds: [error('Forbidden', 'You need the configured mod role, or Manage Server permission, to change the timezone.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!isValidTimezone(tz)) {
            return interaction.reply({
                embeds: [error('Invalid timezone', 'Use an IANA name like `Asia/Tokyo`, `UTC`, `Europe/London`, or `America/Los_Angeles`.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        await db.run(
            `UPDATE guild_settings SET timezone = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?`,
            [tz, guildId]
        );
        await rescheduleGuild(client, guildId);

        return interaction.reply({
            embeds: [success(
                'Timezone Updated',
                [
                    `Server timezone: **${tz}**`,
                    `Local time now: **${formatNowInTz(tz)}**`,
                    'Daily/weekly cron jobs have been rescheduled.',
                ].join('\n')
            )],
            flags: MessageFlags.Ephemeral,
        });
    },
};
