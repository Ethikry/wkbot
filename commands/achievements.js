const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { base, error } = require('../helpers/embeds');
const { getAccountForDiscordUser } = require('../helpers/userLink');
const { evaluateAchievements } = require('../helpers/achievements');
const { awaitInteractionStateRefresh } = require('../helpers/interactionState');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('achievements')
        .setDescription('Show your unlocked WaniKani achievements'),

    async execute(interaction) {
        const userId = interaction.user.id;
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
        case 'milestone': return '🎯 Milestones';
        case 'burn':      return '🔥 Burns';
        case 'streak':    return '🗓️ Streaks';
        case 'volume':    return '📚 Volume';
        default:          return c;
    }
}
