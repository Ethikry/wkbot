const {
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');
const { base, success, error } = require('../helpers/embeds');
const { getAccountForDiscordUser, getWanikaniUserId } = require('../helpers/userLink');
const { getWaniKaniData, getHitRate, getRemainingLessonsForGoal, computeFastestPaceDays, getLevelUpETA } = require('../helpers/wanikaniData');
const { awaitInteractionStateRefresh } = require('../helpers/interactionState');
const {
    paceOptionsFor,
    projectPace,
    isValidDeadline,
    isValidLevel,
    DEFAULT_HIT_RATE,
    MIN_DAYS_PER_LEVEL_SRS,
} = require('../helpers/longgoal');
const wizard = require('../helpers/wizardState');
const db = require('../db');

const NAMESPACE = 'goals';
const id = (...parts) => [NAMESPACE, ...parts].join(':');
const isOurId = (s) => typeof s === 'string' && s.startsWith(`${NAMESPACE}:`);

// One goal model, user-level (identical in every server): an optional
// long-term target (level + deadline, which derives a lessons/day pace) plus
// two daily commitments — lessons/day and "clear my review queue". There are
// deliberately no numeric daily *review* targets: the SRS dictates how many
// reviews come due, so such targets were either trivially met or impossible.

module.exports = {
    data: new SlashCommandBuilder()
        .setName('goals')
        .setDescription('View and manage your WaniKani goals')
        .setDMPermission(true),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await awaitInteractionStateRefresh(interaction, 'goals');
        const payload = await buildOverviewPayload(interaction.user.id);
        return interaction.editReply(payload);
    },

    isOurId,

    async handleButton(interaction, client) {
        const parts = interaction.customId.split(':');
        const action = parts[1];

        if (action === 'set_lt')           return startLtWizardDM(interaction, client);
        if (action === 'set_daily')        return showDailyModal(interaction);
        if (action === 'toggle_clear')     return toggleClearQueue(interaction);
        if (action === 'alerts')           return showAlertConfig(interaction);
        if (action === 'clear')            return showClearConfirm(interaction);
        if (action === 'back')             return rebuildOverview(interaction);
        if (action === 'lt_start')         return showLtInitModal(interaction);
        if (action === 'lt_p')             return handleLtPace(interaction, parts[2]);
        if (action === 'lt_confirm')       return handleLtConfirm(interaction);
        if (action === 'lt_customize')     return handleLtCustomize(interaction);
        if (action === 'lt_cancel')        return handleLtCancel(interaction);
        if (action === 'alert_toggle')     return toggleAlerts(interaction);
        if (action === 'clear_yes')        return execClear(interaction);
        if (action === 'clear_no')         return rebuildOverview(interaction);
    },

    async handleModal(interaction) {
        const cid = interaction.customId;
        if (cid === id('m_daily'))     return handleDailyModal(interaction);
        if (cid === id('m_lt_init'))   return handleLtInitModal(interaction);
        if (cid === id('m_lt_custom')) return handleLtCustomModal(interaction);
    },
};

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

async function buildOverviewPayload(userId) {
    const goal = await db.get(`SELECT * FROM user_goals WHERE discord_user_id = ?`, [userId]);

    let account = null;
    let currentLevel = null;
    try {
        account = await getAccountForDiscordUser(userId);
        if (account) {
            const wk = await getWaniKaniData(account);
            currentLevel = wk.userData.level;
        }
    } catch (e) {
        console.error('[goals overview] WK fetch:', e);
    }

    const lines = [];

    if (goal?.target_level) {
        let proj = null;
        if (currentLevel !== null && goal.deadline) {
            try {
                const [itemCounts, fastest] = await Promise.all([
                    getRemainingLessonsForGoal(account, goal.target_level, currentLevel).catch(err => {
                        console.warn('[goals overview] lesson count projection:', err);
                        return null;
                    }),
                    computeFastestPaceDays(account, currentLevel, goal.target_level).catch(err => {
                        console.warn('[goals overview] fastest pace projection:', err);
                        return null;
                    }),
                ]);
                proj = projectPace({
                    targetLevel: goal.target_level,
                    currentLevel,
                    deadline: goal.deadline,
                    hitRate: goal.hit_rate,
                    dailyLessons: goal.daily_lessons,
                    itemCounts,
                    srsDaysPerLevel: fastest?.avgDaysPerLevel,
                });
            } catch (e) {
                console.error('[goals overview] projection:', e);
            }
        }

        lines.push('**Long-term Goal**');
        lines.push(`🎯 Level ${goal.target_level} by **${goal.deadline ?? 'no deadline'}**`);
        if (currentLevel !== null) lines.push(`Current level: ${currentLevel}`);
        if (proj) {
            if (proj.underWaniKaniMinimum) {
                lines.push(`⛔ Deadline is before your SRS-adjusted minimum — earliest projection **${proj.projectedFinish}**`);
            } else if (proj.feasibleAtPace) {
                lines.push(`✅ On pace — projecting finish around **${proj.projectedFinish}**`);
            } else {
                lines.push(`⚠️ Behind pace — projecting **${proj.projectedFinish}**, past deadline`);
            }
        }
    } else {
        lines.push('**Long-term Goal:** not set');
    }

    // Level-up ETA — on-demand motivation, computed from the local
    // assignments cache (kanji progress at the current level).
    if (account && currentLevel !== null && currentLevel < 60) {
        try {
            const eta = await getLevelUpETA(account, currentLevel);
            if (eta) {
                const unix = Math.floor(eta.eta.getTime() / 1000);
                lines.push(`📈 Level ${currentLevel + 1} <t:${unix}:R> at current pace (${eta.passed}/${eta.threshold} kanji passed)`);
            }
        } catch (e) {
            console.warn('[goals overview] level-up ETA:', e);
        }
    }

    lines.push('');
    lines.push('**Daily Commitments**');
    lines.push(goal?.daily_lessons
        ? `• Lessons: **${goal.daily_lessons}**/day`
        : '• Lessons: no target');
    lines.push(`• Clear review queue: **${goal?.clear_queue ? 'on' : 'off'}**`);

    if (goal?.daily_lessons || goal?.clear_queue) {
        const streak = await db.get(
            `SELECT MAX(goal_current_streak) AS cur, MAX(goal_longest_streak) AS best
             FROM streaks WHERE discord_user_id = ?`,
            [userId]
        );
        if (streak?.best > 0) {
            lines.push(`🎯 Goal streak: **${streak.cur ?? 0}** day${(streak.cur ?? 0) === 1 ? '' : 's'} (best ${streak.best})`);
        }
        lines.push('-# Checked nightly against your daily recap.');
    }

    lines.push('');
    lines.push(`**Alerts:** ${goal?.notify_enabled ? '🔔 on' : '🔕 off'}`);

    const embed = base('🎯 Your Goals').setDescription(lines.join('\n'));
    return {
        embeds: [embed],
        components: overviewButtons(goal),
    };
}

function overviewButtons(goal) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id('set_lt')).setLabel('Set level target').setEmoji('🎯').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(id('set_daily')).setLabel('Daily lessons').setEmoji('✏️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(id('toggle_clear'))
                .setLabel(goal?.clear_queue ? 'Clear queue daily: on' : 'Clear queue daily: off')
                .setEmoji('🧹')
                .setStyle(goal?.clear_queue ? ButtonStyle.Success : ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id('alerts')).setLabel('Configure alerts').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(id('clear')).setLabel('Clear goal').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        ),
    ];
}

async function rebuildOverview(interaction) {
    await interaction.deferUpdate();
    const payload = await buildOverviewPayload(interaction.user.id);
    return interaction.editReply(payload);
}

// Upserts a user_goals row, preserving any columns not being set.
async function upsertGoal(userId, wanikaniUserId, columns) {
    const keys = Object.keys(columns);
    await db.run(
        `INSERT INTO user_goals (discord_user_id, wanikani_user_id, ${keys.join(', ')})
         VALUES (?, ?, ${keys.map(() => '?').join(', ')})
         ON CONFLICT(discord_user_id) DO UPDATE SET
            wanikani_user_id = excluded.wanikani_user_id,
            ${keys.map(k => `${k} = excluded.${k}`).join(', ')},
            updated_at = CURRENT_TIMESTAMP`,
        [userId, wanikaniUserId, ...keys.map(k => columns[k])]
    );
}

// ---------------------------------------------------------------------------
// Daily lessons modal
// ---------------------------------------------------------------------------

async function showDailyModal(interaction) {
    const existing = await db.get(
        `SELECT daily_lessons FROM user_goals WHERE discord_user_id = ?`,
        [interaction.user.id]
    );
    await interaction.showModal(
        new ModalBuilder()
            .setCustomId(id('m_daily'))
            .setTitle('Daily lesson target')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('lessons')
                        .setLabel('Lessons per day (1–500, blank to remove)')
                        .setStyle(TextInputStyle.Short)
                        .setMaxLength(3)
                        .setPlaceholder('e.g. 15')
                        .setValue(existing?.daily_lessons ? String(existing.daily_lessons) : '')
                        .setRequired(false),
                ),
            )
    );
}

async function handleDailyModal(interaction) {
    const lessonsRaw = interaction.fields.getTextInputValue('lessons').trim();

    let dailyLessons = null;
    if (lessonsRaw !== '' && lessonsRaw !== '0') {
        const n = parseInt(lessonsRaw, 10);
        if (!Number.isInteger(n) || n < 1 || n > 500) {
            return respondModal(interaction, {
                embeds: [error('Invalid Lessons', 'Enter a number between 1 and 500, or leave blank to remove the target.')],
                components: [],
            });
        }
        dailyLessons = n;
    }

    const wanikaniUserId = await getWanikaniUserId(interaction.user.id);
    if (!wanikaniUserId) {
        return respondModal(interaction, {
            embeds: [error('No WaniKani Account', 'Run `/setup apikey:<token>` in a server to link your WaniKani account first.')],
            components: [],
        });
    }
    await upsertGoal(interaction.user.id, wanikaniUserId, { daily_lessons: dailyLessons });

    return respondModal(interaction, {
        embeds: [success(
            'Daily Lessons Updated',
            (dailyLessons
                ? `Lessons: **${dailyLessons}**/day.`
                : 'Daily lesson target removed.')
            + '\nYour result shows in the daily recap each day.'
        )],
        components: [backRow()],
    });
}

// ---------------------------------------------------------------------------
// Clear-queue toggle
// ---------------------------------------------------------------------------

async function toggleClearQueue(interaction) {
    await interaction.deferUpdate();
    const wanikaniUserId = await getWanikaniUserId(interaction.user.id);
    if (!wanikaniUserId) {
        return interaction.editReply({
            embeds: [error('No WaniKani Account', 'Run `/setup apikey:<token>` in a server to link your WaniKani account first.')],
            components: [backRow()],
        });
    }
    const existing = await db.get(
        `SELECT clear_queue FROM user_goals WHERE discord_user_id = ?`,
        [interaction.user.id]
    );
    await upsertGoal(interaction.user.id, wanikaniUserId, { clear_queue: existing?.clear_queue ? 0 : 1 });
    const payload = await buildOverviewPayload(interaction.user.id);
    return interaction.editReply(payload);
}

// ---------------------------------------------------------------------------
// Long-term goal wizard (DM flow)
// ---------------------------------------------------------------------------

async function startLtWizardDM(interaction, client) {
    await interaction.deferUpdate();
    const account = await getAccountForDiscordUser(interaction.user.id);
    if (!account) {
        return interaction.editReply({
            embeds: [error('No API Key', 'Run `/setup apikey:<token>` in a server first so the bot can read your WaniKani data.')],
            components: [backRow()],
        });
    }
    try {
        const dm = await interaction.user.createDM();
        await dm.send({
            embeds: [base('🎯 Set a Long-Term Goal').setDescription(
                'Click **Get Started** to set your target level, deadline, and pace.'
            )],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(id('lt_start')).setLabel('Get Started').setEmoji('🎯').setStyle(ButtonStyle.Primary),
            )],
        });
        return interaction.editReply({
            embeds: [success('Check Your DMs! 📬', 'A long-term goal setup has been sent to your DMs.')],
            components: [],
        });
    } catch (e) {
        console.error('[goals] DM send failed:', e);
        return interaction.editReply({
            embeds: [error('Could Not Send DM', 'Unable to DM you. Check that your privacy settings allow DMs from server members.')],
            components: [backRow()],
        });
    }
}

async function showLtInitModal(interaction) {
    await interaction.showModal(
        new ModalBuilder()
            .setCustomId(id('m_lt_init'))
            .setTitle('Set a long-term goal')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('target_level')
                        .setLabel('Target level (2–60)')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(1).setMaxLength(2)
                        .setPlaceholder('e.g. 40')
                        .setRequired(true),
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('deadline')
                        .setLabel('Deadline (YYYY-MM-DD)')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(10).setMaxLength(10)
                        .setPlaceholder('e.g. 2026-12-31')
                        .setRequired(true),
                ),
            )
    );
}

async function handleLtInitModal(interaction) {
    const targetLevel = parseInt(interaction.fields.getTextInputValue('target_level').trim(), 10);
    const deadline = interaction.fields.getTextInputValue('deadline').trim();

    if (!isValidLevel(targetLevel)) {
        return respondModal(interaction, {
            embeds: [error('Invalid Level', 'Target level must be an integer from 2 to 60.')],
            components: [ltCancelRow()],
        });
    }
    if (!isValidDeadline(deadline)) {
        return respondModal(interaction, {
            embeds: [error('Invalid Deadline', 'Use `YYYY-MM-DD` format and pick a date at least one day in the future.')],
            components: [ltCancelRow()],
        });
    }

    await interaction.deferUpdate();
    try {
        const account = await getAccountForDiscordUser(interaction.user.id);
        if (!account) {
            return interaction.editReply({
                embeds: [error('No API Key', 'Run `/setup apikey:<token>` in a server to register your WaniKani token.')],
                components: [],
            });
        }

        let wkData, hitRateData;
        try {
            [wkData, hitRateData] = await Promise.all([
                getWaniKaniData(account),
                getHitRate(account, 30).catch(() => null),
            ]);
        } catch (apiErr) {
            if (apiErr.message?.includes('401') || apiErr.message?.includes('403')) {
                return interaction.editReply({
                    embeds: [error('API Key Rejected', 'WaniKani rejected your stored token. Re-run `/setup apikey:<token>` to refresh it.')],
                    components: [],
                });
            }
            throw apiErr;
        }

        const currentLevel = wkData.userData.level;
        if (targetLevel <= currentLevel) {
            return interaction.editReply({
                embeds: [error('Already Past Target', `You're at level ${currentLevel}. Pick a target above your current level.`)],
                components: [ltCancelRow()],
            });
        }

        const hitRate = hitRateData?.hitRate ?? DEFAULT_HIT_RATE;
        const hitRateSampleSize = hitRateData?.sampleSize ?? 0;
        let itemCounts;
        try {
            itemCounts = await getRemainingLessonsForGoal(account, targetLevel, currentLevel);
        } catch (apiErr) {
            if (apiErr.message?.includes('401') || apiErr.message?.includes('403')) {
                return interaction.editReply({
                    embeds: [error('API Key Rejected', 'WaniKani rejected your stored token. Re-run `/setup apikey:<token>` to refresh it.')],
                    components: [],
                });
            }
            throw apiErr;
        }
        const fastest = await computeFastestPaceDays(account, currentLevel, targetLevel).catch(() => null);
        const srsDaysPerLevel = fastest?.avgDaysPerLevel;

        // Two-tier gate. Run a probe at 100% hit rate to detect physical SRS
        // impossibility (deadline shorter than the raw SRS floor × levels) —
        // that's a hard block. Then probe at the user's real hit rate; if
        // only that probe is infeasible, the deadline is theoretically
        // reachable with better accuracy, so let them through with a warning
        // banner rather than blocking.
        const hardProbe = projectPace({
            targetLevel, currentLevel, deadline, hitRate: 1.0,
            itemCounts, srsDaysPerLevel,
        });
        if (hardProbe.underWaniKaniMinimum) {
            return interaction.editReply({
                embeds: [impossibleGoalEmbed(
                    { targetLevel, currentLevel, deadline },
                    hardProbe,
                )],
                components: [ltCancelRow()],
            });
        }
        const realProbe = projectPace({
            targetLevel, currentLevel, deadline, hitRate,
            itemCounts, srsDaysPerLevel,
        });
        const hitRateWarning = realProbe.underWaniKaniMinimum ? realProbe : null;

        const options = paceOptionsFor({ targetLevel, currentLevel, deadline, hitRate, itemCounts, srsDaysPerLevel });

        wizard.set(interaction.user.id, {
            targetLevel, currentLevel, deadline,
            hitRate, hitRateSampleSize, itemCounts, srsDaysPerLevel,
            chosenPaceKey: null, customLessons: null,
        });

        return interaction.editReply({
            embeds: [paceSelectionEmbed({ targetLevel, currentLevel, deadline, hitRate, hitRateSampleSize, itemCounts, srsDaysPerLevel, options, hitRateWarning })],
            components: ltPaceRows(options),
        });
    } catch (e) {
        console.error('[goals lt_init]', e);
        return interaction.editReply({
            embeds: [error('WaniKani Error', 'Could not load your WaniKani data. Try again in a minute.')],
            components: [],
        });
    }
}

async function handleLtPace(interaction, paceKey) {
    const state = wizard.get(interaction.user.id);
    if (!state) {
        return interaction.update({
            embeds: [error('Session Expired', 'Run `/goals` → Set level target to start again.')],
            components: [],
        });
    }
    const presets = buildPresetMap(state);
    const chosen = presets[paceKey];
    if (!chosen) {
        return interaction.update({
            embeds: [error('Unknown Pace', 'That pace option is no longer available. Please start over.')],
            components: [],
        });
    }
    wizard.update(interaction.user.id, { chosenPaceKey: paceKey, customLessons: null });
    return interaction.update({
        embeds: [ltConfirmEmbed(state, chosen)],
        components: ltConfirmRows(),
    });
}

async function handleLtCustomize(interaction) {
    const state = wizard.get(interaction.user.id);
    if (!state?.chosenPaceKey) {
        return interaction.update({
            embeds: [error('Session Expired', 'Run `/goals` → Set level target to start again.')],
            components: [],
        });
    }
    const chosen = buildPresetMap(state)[state.chosenPaceKey];
    if (!chosen) {
        return interaction.update({
            embeds: [error('Unknown Pace', 'That pace option is no longer available. Please start over.')],
            components: [],
        });
    }
    const currentLessons = state.customLessons ?? chosen.projection.lessonsPerDay;

    await interaction.showModal(
        new ModalBuilder()
            .setCustomId(id('m_lt_custom'))
            .setTitle('Customize long-term goal')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('lessons')
                        .setLabel('Daily lessons')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(1).setMaxLength(4)
                        .setValue(String(currentLessons))
                        .setRequired(true),
                ),
            )
    );
}

// Builds the "deadline is impossible under SRS" error embed shown when a goal
// requires advancing levels faster than WaniKani's SRS allows (even with
// infinite daily lessons). projection.minimumSrsDays is hit-rate-inflated, so
// the earliest feasible date reflects the user's actual accuracy.
function impossibleGoalEmbed(state, projection) {
    const today = new Date();
    const earliest = new Date(today.getTime() + projection.minimumSrsDays * 24 * 60 * 60 * 1000);
    const earliestStr = earliest.toISOString().slice(0, 10);
    const lines = [
        `Reaching **Level ${state.targetLevel}** from Level ${state.currentLevel} takes at least **${projection.minimumSrsDays} days** under WaniKani's SRS at your hit rate (${formatPercent(projection.effectiveHitRate)}).`,
        `Your deadline (${state.deadline}) is only ${projection.daysRemaining} days away — even infinite lessons/day can't beat the SRS timing.`,
        '',
        `Earliest feasible deadline: **${earliestStr}**.`,
        '',
        'Pick a later deadline or a lower target level.',
    ];
    return error('Goal Not Attainable', lines.join('\n'));
}

async function handleLtCustomModal(interaction) {
    const lessons = parseInt(interaction.fields.getTextInputValue('lessons').trim(), 10);

    if (!Number.isInteger(lessons) || lessons < 1 || lessons > 500) {
        return respondModal(interaction, {
            embeds: [error('Invalid Lessons', 'Daily lessons must be between 1 and 500.')],
            components: ltConfirmRows(),
        });
    }

    const state = wizard.get(interaction.user.id);
    if (!state?.chosenPaceKey) {
        return respondModal(interaction, {
            embeds: [error('Session Expired', 'Run `/goals` → Set level target to start again.')],
            components: [],
        });
    }

    const projection = projectPace({
        targetLevel: state.targetLevel,
        currentLevel: state.currentLevel,
        deadline: state.deadline,
        hitRate: state.hitRate,
        dailyLessons: lessons,
        itemCounts: state.itemCounts,
        srsDaysPerLevel: state.srsDaysPerLevel,
    });

    wizard.update(interaction.user.id, { customLessons: lessons });
    const updated = wizard.get(interaction.user.id);

    return respondModal(interaction, {
        embeds: [ltConfirmEmbed(updated, buildCustomOption(updated, projection), { customized: true })],
        components: ltConfirmRows(),
    });
}

async function handleLtConfirm(interaction) {
    const state = wizard.get(interaction.user.id);
    if (!state?.chosenPaceKey) {
        return interaction.update({
            embeds: [error('Session Expired', 'Run `/goals` → Set level target to start again.')],
            components: [],
        });
    }
    const chosen = getChosenOption(state);
    if (!chosen) {
        return interaction.update({
            embeds: [error('Unknown Pace', 'That pace option is no longer available. Please start over.')],
            components: [],
        });
    }
    const finalLessons = chosen.projection.lessonsPerDay;
    const finalHitRate = chosen.projection.effectiveHitRate;

    const wanikaniUserId = await getWanikaniUserId(interaction.user.id);
    if (!wanikaniUserId) {
        return interaction.update({
            embeds: [error('No WaniKani Account', 'Run `/setup apikey:<token>` in a server to link your WaniKani account first.')],
            components: [],
        });
    }
    await upsertGoal(interaction.user.id, wanikaniUserId, {
        target_level: state.targetLevel,
        deadline: state.deadline,
        hit_rate: finalHitRate,
        daily_lessons: finalLessons,
    });
    wizard.remove(interaction.user.id);

    return interaction.update({
        embeds: [success(
            'Long-Term Goal Saved',
            [
                `🎯 **Level ${state.targetLevel} by ${state.deadline}**`,
                `Plan: ${chosen.label} — **${finalLessons}** lessons/day`,
                `Projected finish: **${chosen.projection.projectedFinish}**`,
                '',
                'Run `/goals` to view progress and configure alerts.',
            ].join('\n')
        )],
        components: [],
    });
}

async function handleLtCancel(interaction) {
    wizard.remove(interaction.user.id);
    return interaction.update({
        embeds: [base('🚫 Cancelled').setDescription('No goal was saved.')],
        components: [],
    });
}

// ---------------------------------------------------------------------------
// Alert configuration
// ---------------------------------------------------------------------------

async function showAlertConfig(interaction) {
    await interaction.deferUpdate();
    const goal = await db.get(`SELECT * FROM user_goals WHERE discord_user_id = ?`, [interaction.user.id]);
    if (!goal) {
        return interaction.editReply({
            embeds: [error('No Goal', 'Set a goal first before configuring alerts.')],
            components: [backRow()],
        });
    }
    return interaction.editReply({
        embeds: [alertEmbed(goal)],
        components: [alertButtons(goal)],
    });
}

async function toggleAlerts(interaction) {
    await interaction.deferUpdate();
    const goal = await db.get(`SELECT * FROM user_goals WHERE discord_user_id = ?`, [interaction.user.id]);
    if (!goal) return interaction.editReply({ embeds: [error('No Goal', 'Goal not found.')], components: [] });
    const newVal = goal.notify_enabled ? 0 : 1;
    await db.run(
        `UPDATE user_goals SET notify_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE discord_user_id = ?`,
        [newVal, interaction.user.id]
    );
    goal.notify_enabled = newVal;
    return interaction.editReply({ embeds: [alertEmbed(goal)], components: [alertButtons(goal)] });
}

function alertEmbed(goal) {
    return base('🔔 Alert Configuration').setDescription([
        `**Notifications:** ${goal.notify_enabled ? '🔔 **on**' : '🔕 off'}`,
        '',
        'When on, you\'ll receive a DM:',
        '• If your deadline becomes unattainable or you fall behind pace (checked nightly).',
        '• If you fall behind your daily lesson target (checked nightly).',
    ].join('\n'));
}

function alertButtons(goal) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(id('alert_toggle'))
            .setLabel(goal.notify_enabled ? 'Disable notifications' : 'Enable notifications')
            .setEmoji(goal.notify_enabled ? '🔕' : '🔔')
            .setStyle(goal.notify_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(id('back'))
            .setLabel('Back')
            .setStyle(ButtonStyle.Secondary),
    );
}

// ---------------------------------------------------------------------------
// Clear goal
// ---------------------------------------------------------------------------

function showClearConfirm(interaction) {
    return interaction.update({
        embeds: [base('🗑️ Clear Goal').setDescription([
            'This will remove your goal — level target, daily lesson target, and the clear-queue commitment.',
            '',
            '**This cannot be undone.**',
        ].join('\n'))],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id('clear_yes')).setLabel('Yes, clear it').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(id('clear_no')).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
    });
}

async function execClear(interaction) {
    const userId = interaction.user.id;
    const [result] = await Promise.all([
        db.run(`DELETE FROM user_goals WHERE discord_user_id = ?`, [userId]),
        // Legacy tables (pre-v16) — clear them too so a rollback doesn't
        // resurrect a goal the user explicitly removed.
        db.run(`DELETE FROM long_goals WHERE discord_user_id = ?`, [userId]),
        db.run(`DELETE FROM goals WHERE discord_user_id = ?`, [userId]),
    ]);
    return interaction.update({
        embeds: [success(
            'Goal Cleared',
            result.changes > 0
                ? 'Your goal has been removed.'
                : 'No goal was set — nothing to clear.'
        )],
        components: [],
    });
}

// ---------------------------------------------------------------------------
// Shared render helpers
// ---------------------------------------------------------------------------

function paceSelectionEmbed({ targetLevel, currentLevel, deadline, hitRate, hitRateSampleSize, itemCounts, srsDaysPerLevel, options, hitRateWarning }) {
    const levelsRemaining = Math.max(1, targetLevel - currentLevel);
    const counts = itemCounts && Number.isFinite(itemCounts.total) ? itemCounts : null;
    const vocabTotal = counts ? counts.vocabulary + (counts.kanaVocabulary || 0) : 0;
    const hitRateSampleLabel = hitRateSampleSize
        ? ` (${hitRateSampleSize} answer attempt${hitRateSampleSize === 1 ? '' : 's'})`
        : ' — defaulted';
    const itemsLine = counts
        ? `**Lessons remaining to reach L${targetLevel}:** ${counts.total} (${counts.radicals} radicals · ${counts.kanji} kanji · ${vocabTotal} vocab)${counts.source === 'fallback' ? ' — estimated' : ''}`
        : `**Lessons remaining to reach L${targetLevel}:** ~${levelsRemaining * 140} estimated`;
    // Prefer the user-specific SRS floor (computed from wk_srs_stages for the
    // remaining level range — picks up L1-2 acceleration). Fall back to the
    // static constant when the SRS cache wasn't ready.
    const srsFloor = srsDaysPerLevel ?? MIN_DAYS_PER_LEVEL_SRS;
    const srsLine = srsDaysPerLevel
        ? `Projections assume you clear reviews each day; the SRS floor for **L${currentLevel + 1}–L${targetLevel}** is **${srsFloor.toFixed(2)} days/level** (radicals→Guru, then kanji→Guru) before hit-rate adjustment.`
        : `Projections assume you clear reviews each day; the SRS floor is ~${srsFloor.toFixed(2)} days/level before hit-rate adjustment.`;
    const lines = [];
    if (hitRateWarning) {
        lines.push(
            `⚠️ **Heads-up:** at your current hit rate (${formatPercent(hitRate)}), the SRS floor inflates to **${hitRateWarning.minimumSrsDays} days** for ${levelsRemaining} level${levelsRemaining === 1 ? '' : 's'} — past your deadline (${hitRateWarning.daysRemaining} days away).`,
            'Improving accuracy or extending the deadline will make this attainable. You can still save the goal; overview will keep you informed.',
            '',
        );
    }
    lines.push(
        `**Target:** Level ${targetLevel} by **${deadline}**`,
        `**Current level:** ${currentLevel}`,
        itemsLine,
        `**Hit rate (last 30d):** ${formatPercent(hitRate)}${hitRateSampleLabel}`,
        '',
        'Plans cover **every item you have not started yet** through the target level.',
        srsLine,
    );
    const embed = base('🎯 Choose Your Pace').setDescription(lines.join('\n'));
    for (const opt of options) {
        const p = opt.projection;
        embed.addFields({
            name: `${opt.label} — ${p.lessonsPerDay} lessons/day`,
            value: [
                `**~${p.reviewsPerDay}** reviews/day · finish around **${p.projectedFinish}**`,
                p.underWaniKaniMinimum
                    ? `⛔ Your deadline is before the SRS-adjusted minimum (${p.minimumDaysPerLevel.toFixed(1)} days/level at ${formatPercent(p.effectiveHitRate)})`
                    : p.feasibleAtPace
                        ? '✅ Meets your deadline'
                        : '⚠️ Projects past your deadline',
            ].join('\n'),
        });
    }
    return embed;
}

function ltConfirmEmbed(state, chosen, opts = {}) {
    const p = chosen.projection;
    const totalItems = p.itemCounts?.total ?? state.itemCounts?.total ?? null;
    return base('Review Your Goal').setDescription([
        `🎯 **Level ${state.targetLevel} by ${state.deadline}**`,
        `**Current level:** ${state.currentLevel}`,
        `**Plan:** ${chosen.label}`,
        `**Daily lessons:** ${p.lessonsPerDay}`,
        `**Estimated reviews/day:** ~${p.reviewsPerDay}`,
        `**Projected finish:** ${p.projectedFinish}`,
        totalItems !== null ? `**Workload:** ${totalItems} lessons remaining (across ${p.levelsRemaining} levels)` : null,
        `**Hit rate used:** ${formatPercent(p.effectiveHitRate)}`,
        opts.customized ? '*(lessons/day customised)*' : null,
        '',
        p.underWaniKaniMinimum
            ? '⛔ Your deadline is before the SRS-adjusted minimum, even with reviews cleared daily.'
            : p.feasibleAtPace
                ? '✅ This plan meets your deadline.'
                : `⚠️ Projects finishing ${p.projectedFinish}, past your deadline. Consider a faster pace.`,
        '',
        'Confirm to save, Customise to override lessons/day, or Cancel.',
    ].filter(s => s !== undefined && s !== null).join('\n'));
}

function ltPaceRows(options) {
    const buttons = options.map(opt =>
        new ButtonBuilder()
            .setCustomId(id('lt_p', opt.key))
            .setLabel(opt.labelText || opt.key)
            .setEmoji(opt.emoji || '🎯')
            .setStyle(ButtonStyle.Primary)
    );
    buttons.push(new ButtonBuilder().setCustomId(id('lt_cancel')).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }
    return rows;
}

function ltConfirmRows() {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('lt_confirm')).setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(id('lt_customize')).setLabel('Customise').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id('lt_cancel')).setLabel('Cancel').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
    )];
}

function ltCancelRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('lt_cancel')).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
}

function backRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('back')).setLabel('Back').setStyle(ButtonStyle.Secondary),
    );
}

function buildPresetMap(state) {
    return Object.fromEntries(
        paceOptionsFor({
            targetLevel: state.targetLevel,
            currentLevel: state.currentLevel,
            deadline: state.deadline,
            hitRate: state.hitRate,
            itemCounts: state.itemCounts,
            srsDaysPerLevel: state.srsDaysPerLevel,
        }).map(o => [o.key, o])
    );
}

function getChosenOption(state) {
    if (state.customLessons !== null && state.customLessons !== undefined) {
        return buildCustomOption(state);
    }
    return buildPresetMap(state)[state.chosenPaceKey];
}

function buildCustomOption(state, projection = null) {
    const base = buildPresetMap(state)[state.chosenPaceKey];
    const lessonsPerDay = state.customLessons ?? base?.projection?.lessonsPerDay ?? 1;
    const proj = projection ?? projectPace({
        targetLevel: state.targetLevel,
        currentLevel: state.currentLevel,
        deadline: state.deadline,
        hitRate: state.hitRate,
        dailyLessons: lessonsPerDay,
        itemCounts: state.itemCounts,
        srsDaysPerLevel: state.srsDaysPerLevel,
    });
    return {
        key: 'custom',
        label: '🛠️ Custom',
        emoji: '🛠️',
        labelText: 'Custom',
        dailyLessons: lessonsPerDay,
        projection: proj,
    };
}

function formatPercent(rate) {
    const pct = (rate * 100);
    return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

// respondModal: for modal submit handlers, update the originating message when possible
// (only works when modal was triggered from a message component)
function respondModal(interaction, payload) {
    if (interaction.message) return interaction.update(payload);
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}
