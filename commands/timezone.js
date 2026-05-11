const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isModerator } = require('../helpers/permissions');
const { success, error, base } = require('../helpers/embeds');
const { rescheduleGuild } = require('../scheduler');
const { DEFAULT_TIME_ZONE, isValidTimeZone, resolveTimeZone } = require('../helpers/botTime');
const db = require('../db');

function formatNowInTimeZone(timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date());
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('timezone')
        .setDescription('View or set the bot timezone for this server')
        .setDMPermission(false)
        .addStringOption(o =>
            o.setName('timezone')
                .setDescription('IANA timezone, e.g. Asia/Tokyo or America/Denver')
                .setRequired(false)
        ),

    async execute(interaction, client) {
        const guildId = interaction.guild.id;
        await db.run(
            `INSERT OR IGNORE INTO guild_settings (guild_id, timezone) VALUES (?, ?)`,
            [guildId, DEFAULT_TIME_ZONE]
        );

        const requested = interaction.options.getString('timezone');
        if (!requested) {
            const settings = await db.get(
                `SELECT timezone, daily_summary_time FROM guild_settings WHERE guild_id = ?`,
                [guildId]
            );
            const current = resolveTimeZone(settings?.timezone);
            const embed = base('🕒 Server Timezone')
                .addFields(
                    { name: 'Timezone', value: `**${current}**`, inline: true },
                    { name: 'Daily reset', value: `**${settings?.daily_summary_time ?? '00:00'}** ${current}`, inline: true },
                    { name: 'Now', value: formatNowInTimeZone(current), inline: false },
                );
            return interaction.reply({
                embeds: [embed],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!(await isModerator(interaction))) {
            return interaction.reply({
                embeds: [error('Forbidden', 'You need the configured mod role, or Manage Server permission, to change the timezone.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!isValidTimeZone(requested)) {
            return interaction.reply({
                embeds: [error('Invalid Timezone', 'Use an IANA timezone like `Asia/Tokyo`, `America/Denver`, or `Europe/London`.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        await db.run(
            `UPDATE guild_settings SET timezone = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?`,
            [requested, guildId]
        );
        await rescheduleGuild(client, guildId);

        return interaction.reply({
            embeds: [success(
                'Timezone Updated',
                [
                    `Server timezone: **${requested}**`,
                    `Local time now: **${formatNowInTimeZone(requested)}**`,
                    'Daily/weekly cron jobs have been rescheduled.',
                ].join('\n')
            )],
            flags: MessageFlags.Ephemeral,
        });
    },
};
