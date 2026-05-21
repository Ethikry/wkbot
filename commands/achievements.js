const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { base, error } = require('../helpers/embeds');
const { getAccountForDiscordUser } = require('../helpers/userLink');
const { evaluateAchievements } = require('../helpers/achievements');
const { evaluateGuildAchievements } = require('../helpers/guildAchievements');
const { awaitInteractionStateRefresh } = require('../helpers/interactionState');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('achievements')
        .setDescription('Show your unlocked WaniKani achievements')
        .addBooleanOption(opt =>
            opt.setName('server')
                .setDescription('Show server-wide achievements instead of yours')
                .setRequired(false)
        ),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild?.id;
        const serverView = interaction.options.getBoolean('server') === true;

        if (serverView) {
            if (!guildId) {
                return interaction.reply({
                    embeds: [error('Server-only', 'Run this in a server to see server achievements.')],
                    flags: MessageFlags.Ephemeral,
                });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await evaluateGuildAchievements(guildId).catch(() => {});
            return showGuildView(interaction, guildId);
        }

        const account = await getAccountForDiscordUser(userId);
        if (!account) {
            return interaction.reply({
                embeds: [error('No WaniKani Account', 'Run `/setup apikey:<token>` in a server first.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await awaitInteractionStateRefresh(interaction, 'achievements');

        // Re-evaluate so the user sees up-to-date status, not just whatever the
        // hourly slow-loop has caught.
        await evaluateAchievements({
            discordUserId: userId,
            wanikaniUserId: account.wanikani_user_id,
        }).catch(() => {});

        const definitions = await db.all(
            `SELECT achievement_key, name, description, category
             FROM achievement_definitions
             WHERE category NOT LIKE 'guild_%'
             ORDER BY category, achievement_key`
        );
        const unlocked = await db.all(
            `SELECT achievement_key, unlocked_at
             FROM user_achievements
             WHERE discord_user_id = ?`,
            [userId]
        );
        const unlockedMap = new Map(unlocked.map(r => [r.achievement_key, r.unlocked_at]));

        if (definitions.length === 0) {
            return interaction.editReply({
                embeds: [base('🏅 Achievements').setDescription('No achievements have been defined yet.')],
            });
        }

        const byCategory = new Map();
        for (const def of definitions) {
            if (!byCategory.has(def.category)) byCategory.set(def.category, []);
            byCategory.get(def.category).push(def);
        }

        const unlockedCount = unlocked.length;
        const totalCount = definitions.length;

        const embed = base(`🏅 Achievements — ${unlockedCount}/${totalCount}`)
            .setDescription(unlockedCount === 0
                ? 'No achievements unlocked yet — keep grinding!'
                : `You've unlocked **${unlockedCount}** of **${totalCount}**.`);

        for (const [category, defs] of byCategory) {
            const lines = defs.map(d => {
                const at = unlockedMap.get(d.achievement_key);
                if (at) {
                    return `✅ **${d.name}** — ${d.description}\n     _Unlocked ${at.slice(0, 10)}_`;
                }
                return `🔒 **${d.name}** — ${d.description}`;
            });
            embed.addFields({ name: prettyCategory(category), value: lines.join('\n') });
        }

        return interaction.editReply({ embeds: [embed] });
    },
};

function prettyCategory(c) {
    switch (c) {
        case 'milestone':        return '🎯 Milestones';
        case 'burn':             return '🔥 Burns';
        case 'streak':           return '🗓️ Streaks';
        case 'volume':           return '📚 Volume';
        case 'guild_milestone':  return '🎯 Guild Milestones';
        case 'guild_burn':       return '🔥 Guild Burns';
        case 'guild_streak':     return '🗓️ Guild Streaks';
        case 'guild_volume':     return '📚 Guild Volume';
        default:                 return c;
    }
}

async function showGuildView(interaction, guildId) {
    const definitions = await db.all(
        `SELECT achievement_key, name, description, category
         FROM achievement_definitions
         WHERE category LIKE 'guild_%'
         ORDER BY category, achievement_key`
    );
    const unlocked = await db.all(
        `SELECT achievement_key, unlocked_at, metric_value
         FROM guild_achievements WHERE guild_id = ?`,
        [guildId]
    );
    const unlockedMap = new Map(unlocked.map(r => [r.achievement_key, r]));

    if (definitions.length === 0) {
        return interaction.editReply({
            embeds: [base('🏰 Server Achievements').setDescription('No server achievements defined yet.')],
        });
    }

    const byCategory = new Map();
    for (const def of definitions) {
        if (!byCategory.has(def.category)) byCategory.set(def.category, []);
        byCategory.get(def.category).push(def);
    }

    const embed = base(`🏰 Server Achievements — ${unlocked.length}/${definitions.length}`)
        .setDescription(unlocked.length === 0
            ? 'No server achievements unlocked yet.'
            : `This server has unlocked **${unlocked.length}** of **${definitions.length}**.`);

    for (const [category, defs] of byCategory) {
        const lines = defs.map(d => {
            const row = unlockedMap.get(d.achievement_key);
            if (row) {
                return `✅ **${d.name}** — ${d.description}\n     _Unlocked ${row.unlocked_at.slice(0, 10)}_`;
            }
            return `🔒 **${d.name}** — ${d.description}`;
        });
        embed.addFields({ name: prettyCategory(category), value: lines.join('\n') });
    }

    return interaction.editReply({ embeds: [embed] });
}
