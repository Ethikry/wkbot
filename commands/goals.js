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
const { getApiKeyForUser } = require('../helpers/userKey');
const { getWaniKaniData, getHitRate, getPersonalPace } = require('../helpers/wanikaniData');
const {
    paceOptionsFor,
    projectPace,
    isValidDeadline,
    isValidLevel,
    ITEMS_PER_LEVEL,
    DEFAULT_HIT_RATE,
} = require('../helpers/longgoal');
const wizard = require('../helpers/wizardState');
const db = require('../db');

const NAMESPACE = 'goals';
const id = (...parts) => [NAMESPACE, ...parts].join(':');
const isOurId = (s) => typeof s === 'string' && s.startsWith(`${NAMESPACE}:`);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('goals')
        .setDescription('View and manage your WaniKani goals')
        .setDMPermission(true),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const payload = await buildOverviewPayload(interaction.user.id, interaction.guildId);
        return interaction.editReply(payload);
    },

    isOurId,

    async handleButton(interaction, client) {
        const parts = interaction.customId.split(':');
        const action = parts[1];

        if (action === 'set')              return showGoalTypeSelector(interaction);
        if (action === 'alerts')           return showAlertConfig(interaction);
        if (action === 'clear')            return showClearConfirm(interaction);
        if (action === 'back')             return rebuildOverview(interaction);
        if (action === 'set_lt')           return startLtWizardDM(interaction, client);
        if (action === 'set_daily')        return showDailyModal(interaction);
        if (action === 'lt_start')         return showLtInitModal(interaction);
        if (action === 'lt_p')             return handleLtPace(interaction, parts[2]);
        if (action === 'lt_confirm')       return handleLtConfirm(interaction);
        if (action === 'lt_customize')     return handleLtCustomize(interaction);
        if (action === 'lt_cancel')        return handleLtCancel(interaction);
        if (action === 'alert_pace')       return toggleAlertPace(interaction);
        if (action === 'alert_reviews')    return toggleAlertReviews(interaction);
        if (action === 'alert_threshold')  return showThresholdModal(interaction);
        if (action === 'clear_yes')        return execClear(interaction);
        if (action === 'clear_no')         return rebuildOverview(interaction);
    },

    async handleModal(interaction) {
        const cid = interaction.customId;
        if (cid === id('m_daily'))     return handleDailyModal(interaction);
        if (cid === id('m_threshold')) return handleThresholdModal(interaction);
        if (cid === id('m_lt_init'))   return handleLtInitModal(interaction);
        if (cid === id('m_lt_custom')) return handleLtCustomModal(interaction);
    },
};

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

async function buildOverviewPayload(userId, guildId) {
    const [longGoal, dailyGoal] = await Promise.all([
        db.get(`SELECT * FROM long_goals WHERE user_id = ?`, [userId]),
        guildId
            ? db.get(`SELECT * FROM goals WHERE user_id = ? AND guild_id = ?`, [userId, guildId])
            : null,
    ]);

    const lines = [];

    if (longGoal) {
        let currentLevel = null;
        let proj = null;
        try {
            const apiKey = await getApiKeyForUser(userId, guildId);
            if (apiKey) {
                const wk = await getWaniKaniData(apiKey);
                currentLevel = wk.userData.level;
                proj = projectPace({
                    targetLevel: longGoal.target_level,
                    currentLevel,
                    deadline: longGoal.deadline,
                    hitRate: longGoal.hit_rate,
                    daysPerLevel: longGoal.days_per_level,
                });
            }
        } catch (e) {
            console.error('[goals overview] WK fetch:', e.message);
        }

        lines.push('**Long-term Goal**');
        lines.push(`🎯 Level ${longGoal.target_level} by **${longGoal.deadline}**`);
        if (currentLevel !== null) lines.push(`Current level: ${currentLevel}`);
        lines.push(`Pace: ${fmtPace(longGoal.pace_mode)} — ${longGoal.days_per_level.toFixed(1)} days/level`);
        lines.push(`Daily target: ${longGoal.daily_lessons} lessons · ~${longGoal.daily_reviews} reviews`);
        if (proj) {
            if (proj.underWaniKaniMinimum) {
                lines.push('⛔ Pace is below WaniKani minimum — not achievable');
            } else if (proj.feasibleAtPace) {
                lines.push(`✅ On pace — projecting finish around **${proj.projectedFinish}**`);
            } else {
                lines.push(`⚠️ Behind pace — projecting **${proj.projectedFinish}**, past deadline`);
            }
        }
        lines.push('');
        lines.push('**Alerts**');
        lines.push(`• Daily pace DM: ${longGoal.notify_pace_daily ? 'on' : 'off'}`);
        lines.push(`• Reviews-available DM: ${longGoal.notify_reviews_available ? `on (≥ ${longGoal.notify_review_threshold})` : 'off'}`);
    } else {
        lines.push('**Long-term Goal:** not set');
    }

    if (guildId) {
        lines.push('');
        const hasDailyNumbers = dailyGoal && (dailyGoal.daily_lessons || dailyGoal.daily_reviews || dailyGoal.daily_all);
        if (hasDailyNumbers) {
            lines.push('**Daily Goals** (this server)');
            if (dailyGoal.daily_lessons) lines.push(`• Lessons: **${dailyGoal.daily_lessons}**/day`);
            if (dailyGoal.daily_reviews) lines.push(`• Reviews: **${dailyGoal.daily_reviews}**/day`);
            if (dailyGoal.daily_all)     lines.push('• Clear queue daily: **on**');
        } else if (longGoal) {
            lines.push('**Daily Goals** (this server): derived from long-term goal');
        } else {
            lines.push('**Daily Goals** (this server): not set');
        }
    }

    const embed = base('🎯 Your Goals').setDescription(lines.join('\n'));
    return {
        embeds: [embed],
        components: [overviewButtons()],
    };
}

function overviewButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('set')).setLabel('Set a goal').setEmoji('✍️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id('alerts')).setLabel('Configure alerts').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('clear')).setLabel('Clear goal').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    );
}

async function rebuildOverview(interaction) {
    await interaction.deferUpdate();
    const payload = await buildOverviewPayload(interaction.user.id, interaction.guildId);
    return interaction.editReply(payload);
}

// ---------------------------------------------------------------------------
// Goal type selector
// ---------------------------------------------------------------------------

function showGoalTypeSelector(interaction) {
    const embed = base('🎯 Set a Goal').setDescription([
        '**Long-term goal**',
        'Set a target WaniKani level and deadline. The bot calculates your required daily pace and tracks whether you\'re on track.',
        '',
        '**Daily goal**',
        'Set specific daily lesson and/or review targets for this server\'s progress summary.',
    ].join('\n'));
    return interaction.update({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id('set_lt')).setLabel('Long-term goal').setEmoji('🎯').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(id('set_daily')).setLabel('Daily goal').setEmoji('📋').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(id('back')).setLabel('Back').setStyle(ButtonStyle.Secondary),
        )],
    });
}

// ---------------------------------------------------------------------------
// Long-term goal wizard (DM flow)
// ---------------------------------------------------------------------------

async function startLtWizardDM(interaction, client) {
    await interaction.deferUpdate();
    const apiKey = await getApiKeyForUser(interaction.user.id, interaction.guildId);
    if (!apiKey) {
        return interaction.editReply({
            embeds: [error('No API Key', 'Run `/setup apikey:<token>` in a server first so the bot can read your WaniKani data.')],
            components: [backRow()],
        });
    }
    try {
        const dm = await interaction.user.createDM();
        await dm.send({
            embeds: [base('🎯 Long-Term Goal Wizard').setDescription(
                'Click **Start Wizard** to begin. You\'ll enter a target level, deadline, and choose a pace.'
            )],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(id('lt_start')).setLabel('Start Wizard').setEmoji('🚀').setStyle(ButtonStyle.Primary),
            )],
        });
        return interaction.editReply({
            embeds: [success('Check Your DMs! 📬', 'The long-term goal wizard has been sent to your DMs.')],
            components: [],
        });
    } catch (e) {
        console.error('[goals] DM send failed:', e.message);
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
        const apiKey = await getApiKeyForUser(interaction.user.id, interaction.guildId);
        if (!apiKey) {
            return interaction.editReply({
                embeds: [error('No API Key', 'Run `/setup apikey:<token>` in a server to register your WaniKani token.')],
                components: [],
            });
        }

        let wkData, hitRateData, personalPace;
        try {
            [wkData, hitRateData, personalPace] = await Promise.all([
                getWaniKaniData(apiKey),
                getHitRate(apiKey, 30).catch(() => null),
                getPersonalPace(apiKey).catch(() => null),
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
        const options = paceOptionsFor({ targetLevel, currentLevel, deadline, hitRate, personalPace });

        wizard.set(interaction.user.id, {
            targetLevel, currentLevel, deadline,
            hitRate, hitRateSampleSize, personalPace,
            chosenPaceKey: null, customLessons: null, customReviews: null,
        });

        return interaction.editReply({
            embeds: [paceSelectionEmbed({ targetLevel, currentLevel, deadline, hitRate, hitRateSampleSize, options })],
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
            embeds: [error('Wizard Expired', 'Run `/goals` → Set a goal → Long-term goal to start again.')],
            components: [],
        });
    }
    const presets = buildPresetMap(state);
    const chosen = presets[paceKey];
    if (!chosen) {
        return interaction.update({
            embeds: [error('Unknown Pace', 'That pace option is no longer available. Start the wizard again.')],
            components: [],
        });
    }
    wizard.update(interaction.user.id, { chosenPaceKey: paceKey, customLessons: null, customReviews: null });
    return interaction.update({
        embeds: [ltConfirmEmbed(state, chosen)],
        components: ltConfirmRows(),
    });
}

async function handleLtCustomize(interaction) {
    const state = wizard.get(interaction.user.id);
    if (!state?.chosenPaceKey) {
        return interaction.update({
            embeds: [error('Wizard Expired', 'Run `/goals` → Set a goal → Long-term goal to start again.')],
            components: [],
        });
    }
    const chosen = buildPresetMap(state)[state.chosenPaceKey];
    await interaction.showModal(
        new ModalBuilder()
            .setCustomId(id('m_lt_custom'))
            .setTitle('Customize daily targets')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('lessons')
                        .setLabel('Daily lessons')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(1).setMaxLength(4)
                        .setValue(String(state.customLessons ?? chosen.projection.lessonsPerDay))
                        .setRequired(true),
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('reviews')
                        .setLabel('Daily reviews (estimate)')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(1).setMaxLength(4)
                        .setValue(String(state.customReviews ?? chosen.projection.reviewsPerDay))
                        .setRequired(true),
                ),
            )
    );
}

async function handleLtCustomModal(interaction) {
    const lessons = parseInt(interaction.fields.getTextInputValue('lessons').trim(), 10);
    const reviews = parseInt(interaction.fields.getTextInputValue('reviews').trim(), 10);

    if (!Number.isInteger(lessons) || lessons < 1 || lessons > 500) {
        return respondModal(interaction, {
            embeds: [error('Invalid Lessons', 'Daily lessons must be between 1 and 500.')],
            components: ltConfirmRows(),
        });
    }
    if (!Number.isInteger(reviews) || reviews < 1 || reviews > 2000) {
        return respondModal(interaction, {
            embeds: [error('Invalid Reviews', 'Daily reviews must be between 1 and 2000.')],
            components: ltConfirmRows(),
        });
    }

    const state = wizard.get(interaction.user.id);
    if (!state?.chosenPaceKey) {
        return respondModal(interaction, {
            embeds: [error('Wizard Expired', 'Run `/goals` → Set a goal → Long-term goal to start again.')],
            components: [],
        });
    }

    wizard.update(interaction.user.id, { customLessons: lessons, customReviews: reviews });
    const updated = wizard.get(interaction.user.id);
    const chosen = buildPresetMap(updated)[updated.chosenPaceKey];
    const override = { ...chosen, projection: { ...chosen.projection, lessonsPerDay: lessons, reviewsPerDay: reviews } };

    return respondModal(interaction, {
        embeds: [ltConfirmEmbed(updated, override, { customized: true })],
        components: ltConfirmRows(),
    });
}

async function handleLtConfirm(interaction) {
    const state = wizard.get(interaction.user.id);
    if (!state?.chosenPaceKey) {
        return interaction.update({
            embeds: [error('Wizard Expired', 'Run `/goals` → Set a goal → Long-term goal to start again.')],
            components: [],
        });
    }
    const chosen = buildPresetMap(state)[state.chosenPaceKey];
    const finalLessons = state.customLessons ?? chosen.projection.lessonsPerDay;
    const finalReviews = state.customReviews ?? chosen.projection.reviewsPerDay;

    await db.run(
        `INSERT INTO long_goals (
            user_id, target_level, deadline, pace_mode,
            days_per_level, items_per_level,
            daily_lessons, daily_reviews, hit_rate, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            target_level = excluded.target_level,
            deadline = excluded.deadline,
            pace_mode = excluded.pace_mode,
            days_per_level = excluded.days_per_level,
            items_per_level = excluded.items_per_level,
            daily_lessons = excluded.daily_lessons,
            daily_reviews = excluded.daily_reviews,
            hit_rate = excluded.hit_rate,
            created_at = excluded.created_at`,
        [
            interaction.user.id, state.targetLevel, state.deadline, chosen.key,
            chosen.daysPerLevel, ITEMS_PER_LEVEL,
            finalLessons, finalReviews, state.hitRate,
            new Date().toISOString(),
        ]
    );
    wizard.remove(interaction.user.id);

    return interaction.update({
        embeds: [success(
            'Long-Term Goal Saved',
            [
                `🎯 **Level ${state.targetLevel} by ${state.deadline}**`,
                `Pace: ${chosen.label} (${chosen.daysPerLevel.toFixed(1)} days/level)`,
                `Daily target: **${finalLessons}** lessons · **${finalReviews}** reviews`,
                '',
                'Run `/goals` in a server to view progress and configure alerts.',
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
// Daily goal modal
// ---------------------------------------------------------------------------

async function showDailyModal(interaction) {
    if (!interaction.guildId) {
        return interaction.update({
            embeds: [error('Server Only', 'Daily goals can only be set within a server, not in DMs.')],
            components: [backRow()],
        });
    }
    const existing = await db.get(
        `SELECT daily_lessons, daily_reviews, daily_all FROM goals WHERE user_id = ? AND guild_id = ?`,
        [interaction.user.id, interaction.guildId]
    );
    await interaction.showModal(
        new ModalBuilder()
            .setCustomId(id('m_daily'))
            .setTitle('Set Daily Goals')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('lessons')
                        .setLabel("Daily lesson target (0–500, or 'all')")
                        .setStyle(TextInputStyle.Short)
                        .setMaxLength(5)
                        .setPlaceholder("e.g. 20")
                        .setValue(existing?.daily_lessons ? String(existing.daily_lessons) : '')
                        .setRequired(false),
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('reviews')
                        .setLabel("Daily review target (0–2000, or 'all')")
                        .setStyle(TextInputStyle.Short)
                        .setMaxLength(5)
                        .setPlaceholder("e.g. 100")
                        .setValue(existing?.daily_all ? 'all' : (existing?.daily_reviews ? String(existing.daily_reviews) : ''))
                        .setRequired(false),
                ),
            )
    );
}

async function handleDailyModal(interaction) {
    if (!interaction.guildId) {
        return respondModal(interaction, {
            embeds: [error('Server Only', 'Daily goals require a server context.')],
            components: [],
        });
    }

    const lessonsRaw = interaction.fields.getTextInputValue('lessons').trim().toLowerCase();
    const reviewsRaw = interaction.fields.getTextInputValue('reviews').trim().toLowerCase();

    let dailyLessons = 0, dailyReviews = 0, dailyAll = 0;

    if (lessonsRaw === 'all') {
        dailyAll = 1;
    } else if (lessonsRaw !== '') {
        const n = parseInt(lessonsRaw, 10);
        if (!Number.isInteger(n) || n < 0 || n > 500) {
            return respondModal(interaction, {
                embeds: [error('Invalid Lessons', "Enter a number between 0 and 500, or 'all'.")],
                components: [],
            });
        }
        dailyLessons = n;
    }

    if (reviewsRaw === 'all') {
        dailyAll = 1;
    } else if (reviewsRaw !== '') {
        const n = parseInt(reviewsRaw, 10);
        if (!Number.isInteger(n) || n < 0 || n > 2000) {
            return respondModal(interaction, {
                embeds: [error('Invalid Reviews', "Enter a number between 0 and 2000, or 'all'.")],
                components: [],
            });
        }
        dailyReviews = n;
    }

    const { user: { id: userId }, guildId } = interaction;
    const existing = await db.get(
        `SELECT daily_lessons FROM goals WHERE user_id = ? AND guild_id = ?`,
        [userId, guildId]
    );
    if (existing) {
        await db.run(
            `UPDATE goals SET daily_lessons = ?, daily_reviews = ?, daily_all = ? WHERE user_id = ? AND guild_id = ?`,
            [dailyLessons, dailyReviews, dailyAll, userId, guildId]
        );
    } else {
        await db.run(
            `INSERT INTO goals (user_id, guild_id, daily_lessons, daily_reviews, daily_all) VALUES (?, ?, ?, ?, ?)`,
            [userId, guildId, dailyLessons, dailyReviews, dailyAll]
        );
    }

    const summaryParts = dailyAll
        ? ['Clear queue daily: **on**']
        : [
            dailyLessons ? `Lessons: **${dailyLessons}**/day` : null,
            dailyReviews ? `Reviews: **${dailyReviews}**/day` : null,
            (!dailyLessons && !dailyReviews) ? 'No specific targets set.' : null,
        ].filter(Boolean);

    return respondModal(interaction, {
        embeds: [success('Daily Goals Updated', summaryParts.join('\n') + '\nProgress appears in the daily summary.')],
        components: [backRow()],
    });
}

// ---------------------------------------------------------------------------
// Alert configuration
// ---------------------------------------------------------------------------

async function showAlertConfig(interaction) {
    await interaction.deferUpdate();
    const goal = await db.get(`SELECT * FROM long_goals WHERE user_id = ?`, [interaction.user.id]);
    if (!goal) {
        return interaction.editReply({
            embeds: [error('No Long-Term Goal', 'Set a long-term goal first before configuring alerts.')],
            components: [backRow()],
        });
    }
    return interaction.editReply({
        embeds: [alertEmbed(goal)],
        components: [alertButtons(goal)],
    });
}

async function toggleAlertPace(interaction) {
    await interaction.deferUpdate();
    const goal = await db.get(`SELECT * FROM long_goals WHERE user_id = ?`, [interaction.user.id]);
    if (!goal) return interaction.editReply({ embeds: [error('No Goal', 'Long-term goal not found.')], components: [] });
    const newVal = goal.notify_pace_daily ? 0 : 1;
    await db.run(`UPDATE long_goals SET notify_pace_daily = ? WHERE user_id = ?`, [newVal, interaction.user.id]);
    goal.notify_pace_daily = newVal;
    return interaction.editReply({ embeds: [alertEmbed(goal)], components: [alertButtons(goal)] });
}

async function toggleAlertReviews(interaction) {
    await interaction.deferUpdate();
    const goal = await db.get(`SELECT * FROM long_goals WHERE user_id = ?`, [interaction.user.id]);
    if (!goal) return interaction.editReply({ embeds: [error('No Goal', 'Long-term goal not found.')], components: [] });
    const newVal = goal.notify_reviews_available ? 0 : 1;
    await db.run(`UPDATE long_goals SET notify_reviews_available = ? WHERE user_id = ?`, [newVal, interaction.user.id]);
    goal.notify_reviews_available = newVal;
    return interaction.editReply({ embeds: [alertEmbed(goal)], components: [alertButtons(goal)] });
}

async function showThresholdModal(interaction) {
    const goal = await db.get(`SELECT notify_review_threshold FROM long_goals WHERE user_id = ?`, [interaction.user.id]);
    await interaction.showModal(
        new ModalBuilder()
            .setCustomId(id('m_threshold'))
            .setTitle('Set Review Alert Threshold')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('threshold')
                        .setLabel('Alert when review queue reaches (1–1000)')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(1).setMaxLength(4)
                        .setValue(String(goal?.notify_review_threshold ?? 50))
                        .setRequired(true),
                ),
            )
    );
}

async function handleThresholdModal(interaction) {
    const n = parseInt(interaction.fields.getTextInputValue('threshold').trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
        return respondModal(interaction, {
            embeds: [error('Invalid Threshold', 'Enter a number between 1 and 1000.')],
            components: [],
        });
    }
    await db.run(`UPDATE long_goals SET notify_review_threshold = ? WHERE user_id = ?`, [n, interaction.user.id]);
    const goal = await db.get(`SELECT * FROM long_goals WHERE user_id = ?`, [interaction.user.id]);
    return respondModal(interaction, { embeds: [alertEmbed(goal)], components: [alertButtons(goal)] });
}

function alertEmbed(goal) {
    return base('🔔 Alert Configuration').setDescription([
        '**Daily Pace DM**',
        `Status: ${goal.notify_pace_daily ? '🔔 **on**' : '🔕 off'}`,
        'Sends a DM if you complete fewer than 50% of your daily lesson target by 10 PM.',
        '',
        '**Reviews-Available DM**',
        `Status: ${goal.notify_reviews_available ? `🔔 **on** (≥ ${goal.notify_review_threshold} reviews)` : '🔕 off'}`,
        'Sends a DM when your review queue exceeds the threshold. Max once every 4 hours.',
    ].join('\n'));
}

function alertButtons(goal) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(id('alert_pace'))
            .setLabel(goal.notify_pace_daily ? 'Disable pace DM' : 'Enable pace DM')
            .setEmoji(goal.notify_pace_daily ? '🔕' : '🔔')
            .setStyle(goal.notify_pace_daily ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(id('alert_reviews'))
            .setLabel(goal.notify_reviews_available ? 'Disable reviews DM' : 'Enable reviews DM')
            .setEmoji(goal.notify_reviews_available ? '🔕' : '🔔')
            .setStyle(goal.notify_reviews_available ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(id('alert_threshold'))
            .setLabel(`Set threshold (${goal.notify_review_threshold})`)
            .setEmoji('⚙️')
            .setStyle(ButtonStyle.Secondary),
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
        embeds: [base('🗑️ Clear All Goals').setDescription([
            'This will remove:',
            '• Your long-term goal (if set)',
            '• Your daily goals across all servers',
            '',
            '**This cannot be undone.**',
        ].join('\n'))],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id('clear_yes')).setLabel('Yes, clear everything').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(id('clear_no')).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
    });
}

async function execClear(interaction) {
    const userId = interaction.user.id;
    const [ltResult] = await Promise.all([
        db.run(`DELETE FROM long_goals WHERE user_id = ?`, [userId]),
        db.run(`DELETE FROM goals WHERE user_id = ?`, [userId]),
    ]);
    return interaction.update({
        embeds: [success(
            'Goals Cleared',
            ltResult.changes > 0
                ? 'Your long-term goal and all daily goals have been removed.'
                : 'No goals were set — nothing to clear.'
        )],
        components: [],
    });
}

// ---------------------------------------------------------------------------
// Shared render helpers
// ---------------------------------------------------------------------------

function paceSelectionEmbed({ targetLevel, currentLevel, deadline, hitRate, hitRateSampleSize, options }) {
    const embed = base('🎯 Choose Your Pace').setDescription([
        `**Target:** Level ${targetLevel} by **${deadline}**`,
        `**Current level:** ${currentLevel}`,
        `**Hit rate (last 30d):** ${(hitRate * 100).toFixed(0)}%${hitRateSampleSize ? ` (${hitRateSampleSize} reviews)` : ' — defaulted'}`,
        '',
        'Pick a pace below. Daily review estimates assume your hit rate stays stable.',
    ].join('\n'));
    for (const opt of options) {
        const p = opt.projection;
        embed.addFields({
            name: `${opt.label} — ${opt.daysPerLevel.toFixed(1)} days/level`,
            value: [
                opt.summary,
                `**${p.lessonsPerDay}** lessons/day · **~${p.reviewsPerDay}** reviews/day`,
                p.underWaniKaniMinimum
                    ? '⛔ Below WaniKani SRS minimum — not achievable'
                    : p.feasibleAtPace ? `✅ Finishes ~${p.projectedFinish}` : `⚠️ Finishes ~${p.projectedFinish} — past deadline`,
            ].join('\n'),
        });
    }
    return embed;
}

function ltConfirmEmbed(state, chosen, opts = {}) {
    const p = chosen.projection;
    return base('Review Your Goal').setDescription([
        `🎯 **Level ${state.targetLevel} by ${state.deadline}**`,
        `**Current level:** ${state.currentLevel}`,
        `**Pace:** ${chosen.label} — ${chosen.daysPerLevel.toFixed(1)} days/level`,
        `**Daily target:** ${p.lessonsPerDay} lessons · ~${p.reviewsPerDay} reviews`,
        `**Hit rate:** ${(state.hitRate * 100).toFixed(0)}%`,
        opts.customized ? '*(targets customised)*' : '',
        '',
        p.underWaniKaniMinimum
            ? '⛔ Below WaniKani\'s SRS minimum — not physically achievable.'
            : p.feasibleAtPace
                ? `✅ At this pace you'd finish around ${p.projectedFinish}, ahead of deadline.`
                : `⚠️ Projects finishing ${p.projectedFinish}, past your deadline. Consider a faster pace.`,
        '',
        'Confirm to save, Customise to override daily targets, or Cancel.',
    ].filter(s => s !== undefined).join('\n'));
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
            personalPace: state.personalPace,
        }).map(o => [o.key, o])
    );
}

function fmtPace(mode) {
    switch (mode) {
        case 'fastest':     return '🚀 Fastest';
        case 'comfortable': return '🎯 Comfortable';
        case 'relaxed':     return '🏖️ Relaxed';
        case 'personal':    return '📊 Personal';
        default:            return mode || 'custom';
    }
}

// respondModal: for modal submit handlers, update the originating message when possible
// (only works when modal was triggered from a message component)
function respondModal(interaction, payload) {
    if (interaction.message) return interaction.update(payload);
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}
