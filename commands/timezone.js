const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isModerator } = require('../helpers/permissions');
const { success, error, base } = require('../helpers/embeds');
const { rescheduleGuild } = require('../scheduler');
const { DEFAULT_TIME_ZONE, isValidTimeZone, resolveTimeZone } = require('../helpers/botTime');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('timezone')
        .setDescription('View or set this server\'s bot timezone')
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
            const settings = await db.get(`SELECT timezone FROM guild_settings WHERE guild_id = ?`, [guildId]);
            return interaction.reply({
                embeds: [base('🕒 Server Timezone')
                    .setDescription(`Current timezone: **${resolveTimeZone(settings?.timezone)}**`)],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!(await isModerator(interaction))) {
            return interaction.reply({
                embeds: [error('Forbidden', 'You need the configured mod role, or Manage Server permission, to change this.')],
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
            embeds: [success('Timezone Updated', `This server now uses **${requested}**.`)],
            flags: MessageFlags.Ephemeral,
        });
    },
};
