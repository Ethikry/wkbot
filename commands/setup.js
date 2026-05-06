const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isApiKeyValid, isApiKeyFormatValid } = require('../helpers/apikeyTest');
const { encrypt } = require('../helpers/crypto');
const { success, error } = require('../helpers/embeds');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Set your WaniKani API key and personal preferences')
        .setDMPermission(false)
        .addStringOption(opt =>
            opt.setName('apikey')
                .setDescription('Your WaniKani read-only API token')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('ping')
                .setDescription('Receive daily ping with your stats')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('shame')
                .setDescription('Show shame messages alongside your name in daily/weekly posts when you fall short')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('cleared')
                .setDescription('Announce in channel when you clear your review queue (requires server to have this enabled)')
                .setRequired(false)
        ),

    async execute(interaction) {
        const apiKey = interaction.options.getString('apikey');
        const pingOpt = interaction.options.getBoolean('ping');
        const shameOpt = interaction.options.getBoolean('shame');
        const clearedOpt = interaction.options.getBoolean('cleared');
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;

        if (apiKey) {
            if (!isApiKeyFormatValid(apiKey)) {
                return interaction.reply({
                    embeds: [error(
                        'Invalid API Key Format',
                        "That doesn't look like a WaniKani API token. It should be a UUID, e.g. `a1b2c3d4-1234-1234-1234-123456789abc`. Generate one at https://www.wanikani.com/settings/personal_access_tokens"
                    )],
                    flags: MessageFlags.Ephemeral,
                });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const valid = await isApiKeyValid(apiKey);
            if (!valid) {
                return interaction.editReply({
                    embeds: [error('Invalid API Key', 'WaniKani rejected that token. Make sure it is a current, valid token.')],
                });
            }
        }

        const respond = async (payload) => {
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(payload);
            }
            return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
        };

        const existing = await db.get(
            `SELECT api_key, ping_enabled, shame_enabled, cleared_enabled FROM apikeys WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId]
        );

        if (!existing) {
            if (!apiKey) {
                return respond({
                    embeds: [error(
                        'API Key Required',
                        "You haven't set an API key yet. Provide one with `/setup apikey:<token>`."
                    )],
                });
            }
            const ping = pingOpt === null ? 1 : (pingOpt ? 1 : 0);
            const shame = shameOpt === null ? 0 : (shameOpt ? 1 : 0);
            const cleared = clearedOpt === null ? 1 : (clearedOpt ? 1 : 0);
            await db.run(
                `INSERT INTO apikeys (user_id, guild_id, api_key, ping_enabled, shame_enabled, cleared_enabled) VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, guildId, encrypt(apiKey), ping, shame, cleared]
            );
            return respond({
                embeds: [success(
                    'Setup Complete',
                    [
                        'Your API key is saved.',
                        `Daily pings: **${ping ? 'enabled' : 'disabled'}**.`,
                        `Shame messages: **${shame ? 'enabled' : 'disabled'}**.`,
                        `Queue-cleared announcements: **${cleared ? 'enabled' : 'disabled'}**.`,
                    ].join('\n')
                )],
            });
        }

        const fields = [];
        const params = [];
        if (apiKey) {
            fields.push('api_key = ?');
            params.push(encrypt(apiKey));
        }
        if (pingOpt !== null) {
            fields.push('ping_enabled = ?');
            params.push(pingOpt ? 1 : 0);
        }
        if (shameOpt !== null) {
            fields.push('shame_enabled = ?');
            params.push(shameOpt ? 1 : 0);
        }
        if (clearedOpt !== null) {
            fields.push('cleared_enabled = ?');
            params.push(clearedOpt ? 1 : 0);
        }

        if (fields.length === 0) {
            return respond({
                embeds: [error('Nothing to Update', 'Provide an `apikey`, `ping`, `shame`, or `cleared` value to change.')],
            });
        }

        params.push(userId, guildId);
        await db.run(
            `UPDATE apikeys SET ${fields.join(', ')} WHERE user_id = ? AND guild_id = ?`,
            params
        );

        const newPing = pingOpt === null ? existing.ping_enabled : (pingOpt ? 1 : 0);
        const newShame = shameOpt === null ? existing.shame_enabled : (shameOpt ? 1 : 0);
        const newCleared = clearedOpt === null ? existing.cleared_enabled : (clearedOpt ? 1 : 0);
        const lines = [];
        if (apiKey) lines.push('API key updated.');
        if (pingOpt !== null) lines.push(`Daily pings: **${newPing ? 'enabled' : 'disabled'}**.`);
        if (shameOpt !== null) lines.push(`Shame messages: **${newShame ? 'enabled' : 'disabled'}**.`);
        if (clearedOpt !== null) lines.push(`Queue-cleared announcements: **${newCleared ? 'enabled' : 'disabled'}**.`);

        return respond({
            embeds: [success('Settings Updated', lines.join('\n'))],
        });
    },
};
