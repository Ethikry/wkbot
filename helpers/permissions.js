const { PermissionFlagsBits } = require('discord.js');
const db = require('../db');

function normalizeDiscordId(value) {
    return String(value ?? '')
        .trim()
        .replace(/^<@!?/, '')
        .replace(/>$/, '');
}

function getMasterIds() {
    return (process.env.MASTER || '')
        .split(/[,\s]+/)
        .map(normalizeDiscordId)
        .filter(Boolean);
}

function isMaster(userId) {
    return getMasterIds().includes(normalizeDiscordId(userId));
}

async function isModerator(interaction) {
    if (!interaction?.user) return false;
    if (isMaster(interaction.user.id)) return true;
    if (!interaction.guild || !interaction.member) return false;

    const perms = interaction.member.permissions;
    if (perms?.has?.(PermissionFlagsBits.Administrator)) return true;
    if (perms?.has?.(PermissionFlagsBits.ManageGuild)) return true;

    const settings = await db.get(
        `SELECT mod_role_id FROM guild_settings WHERE guild_id = ?`,
        [interaction.guild.id]
    );
    if (settings?.mod_role_id && interaction.member.roles?.cache?.has(settings.mod_role_id)) {
        return true;
    }
    return false;
}

module.exports = { isMaster, isModerator, getMasterIds };
