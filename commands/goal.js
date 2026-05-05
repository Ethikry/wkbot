const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { base, success, error, warn } = require('../helpers/embeds');
const { projectPace } = require('../helpers/longgoal');
const { getApiKeyForUser } = require('../helpers/userKey');
const { getWaniKaniData } = require('../helpers/wanikaniData');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('goal')
        .setDescription('View or manage your long-term WaniKani goal')
        .setDMPermission(true)
        .addSubcommand(s => s.setName('show').setDescription('Show your current long-term goal and pace'))
        .addSubcommand(s =>
            s.setName('alerts')
                .setDescription('Configure DM notifications for your long-term goal')
                .addBooleanOption(o => o.setName('pace_daily').setDescription('Daily DM if you fall behind on lessons'))
                .addBooleanOption(o => o.setName('reviews_available').setDescription('DM when reviews pile up past a threshold'))
                .addIntegerOption(o => o.setName('review_threshold').setDescription('Reviews-available DM trigger (1-1000)').setMinValue(1).setMaxValue(1000))
        )
        .addSubcommand(s => s.setName('clear').setDescription('Delete your long-term goal')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'show') return showGoal(interaction);
        if (sub === 'alerts') return setAlerts(interaction);
        if (sub === 'clear') return clearGoal(interaction);
    },
};

async function showGoal(interaction) {
    const userId = interaction.user.id;
    const goal = await db.get(`SELECT * FROM long_goals WHERE user_id = ?`, [userId]);
    if (!goal) {
        return interaction.reply({
            embeds: [error('No Long-Term Goal', 'Run `/set_goal` to create one.')],
            flags: MessageFlags.Ephemeral,
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let currentLevel = null;
    let liveProjection = null;
    try {
        const apiKey = await getApiKeyForUser(userId, interaction.guildId);
        if (apiKey) {
            const data = await getWaniKaniData(apiKey);
            currentLevel = data.userData.level;
            liveProjection = projectPace({
                targetLevel: goal.target_level,
                currentLevel,
                deadline: goal.deadline,
                hitRate: goal.hit_rate,
                daysPerLevel: goal.days_per_level,
            });
        }
    } catch (err) {
        console.error('[goal show] WK fetch:', err.message);
    }

    const lines = [
        `🎯 **Level ${goal.target_level} by ${goal.deadline}**`,
        currentLevel !== null ? `**Current level:** ${currentLevel}` : null,
        `**Pace:** ${formatPaceLabel(goal.pace_mode)} — ${goal.days_per_level.toFixed(1)} days/level`,
        `**Daily target:** ${goal.daily_lessons} lessons · ~${goal.daily_reviews} reviews`,
        goal.hit_rate ? `**Hit rate factored in:** ${(goal.hit_rate * 100).toFixed(0)}%` : null,
    ].filter(Boolean);

    if (liveProjection) {
        lines.push('');
        lines.push(
            liveProjection.underWaniKaniMinimum
                ? '⛔ Pace is below the WaniKani SRS minimum — physically unreachable.'
                : liveProjection.feasibleAtPace
                    ? `✅ On pace — projecting finish around **${liveProjection.projectedFinish}**.`
                    : `⚠️ Behind pace — projecting finish around **${liveProjection.projectedFinish}**, past your deadline.`
        );
        lines.push(`**Days remaining:** ${liveProjection.daysRemaining} · **Levels remaining:** ${liveProjection.levelsRemaining}`);
    }

    lines.push('');
    lines.push('**Alerts**');
    lines.push(`• Daily pace DM: ${goal.notify_pace_daily ? 'on' : 'off'}`);
    lines.push(`• Reviews-available DM: ${goal.notify_reviews_available ? `on (≥ ${goal.notify_review_threshold})` : 'off'}`);

    return interaction.editReply({
        embeds: [base('🎯 Long-Term Goal').setDescription(lines.join('\n'))],
    });
}

async function setAlerts(interaction) {
    const userId = interaction.user.id;
    const goal = await db.get(`SELECT * FROM long_goals WHERE user_id = ?`, [userId]);
    if (!goal) {
        return interaction.reply({
            embeds: [error('No Long-Term Goal', 'Run `/set_goal` to create one before configuring alerts.')],
            flags: MessageFlags.Ephemeral,
        });
    }

    const paceDaily = interaction.options.getBoolean('pace_daily');
    const reviewsAvailable = interaction.options.getBoolean('reviews_available');
    const threshold = interaction.options.getInteger('review_threshold');

    if (paceDaily === null && reviewsAvailable === null && threshold === null) {
        return interaction.reply({
            embeds: [error('Nothing to Update', 'Provide at least one alert option to change.')],
            flags: MessageFlags.Ephemeral,
        });
    }

    const fields = [];
    const params = [];
    if (paceDaily !== null) { fields.push('notify_pace_daily = ?'); params.push(paceDaily ? 1 : 0); }
    if (reviewsAvailable !== null) { fields.push('notify_reviews_available = ?'); params.push(reviewsAvailable ? 1 : 0); }
    if (threshold !== null) { fields.push('notify_review_threshold = ?'); params.push(threshold); }
    params.push(userId);

    await db.run(
        `UPDATE long_goals SET ${fields.join(', ')} WHERE user_id = ?`,
        params
    );

    const updated = await db.get(`SELECT * FROM long_goals WHERE user_id = ?`, [userId]);
    return interaction.reply({
        embeds: [success(
            'Alerts Updated',
            [
                `Daily pace DM: **${updated.notify_pace_daily ? 'on' : 'off'}**`,
                `Reviews-available DM: **${updated.notify_reviews_available ? 'on' : 'off'}** (threshold ${updated.notify_review_threshold})`,
            ].join('\n')
        )],
        flags: MessageFlags.Ephemeral,
    });
}

async function clearGoal(interaction) {
    const userId = interaction.user.id;
    const result = await db.run(`DELETE FROM long_goals WHERE user_id = ?`, [userId]);
    if (result.changes === 0) {
        return interaction.reply({
            embeds: [warn('Nothing to Clear', 'You don\'t have a long-term goal set.')],
            flags: MessageFlags.Ephemeral,
        });
    }
    return interaction.reply({
        embeds: [success('Goal Cleared', 'Your long-term goal and alert settings have been removed.')],
        flags: MessageFlags.Ephemeral,
    });
}

function formatPaceLabel(mode) {
    switch (mode) {
        case 'fastest': return '🚀 Fastest';
        case 'comfortable': return '🎯 Comfortable';
        case 'relaxed': return '🏖️ Relaxed';
        case 'personal': return '📊 Personal';
        default: return mode || 'custom';
    }
}
