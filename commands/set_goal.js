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
const { base, error, success } = require('../helpers/embeds');
const { getApiKeyForUser } = require('../helpers/userKey');
const { getWaniKaniData, getHitRate, getPersonalPace } = require('../helpers/wanikaniData');
const {
    paceOptionsFor,
    projectPace,
    isValidDeadline,
    isValidLevel,
    ITEMS_PER_LEVEL,
    DEFAULT_HIT_RATE,
    MIN_DAYS_PER_LEVEL,
} = require('../helpers/longgoal');
const wizard = require('../helpers/wizardState');
const db = require('../db');

const NAMESPACE = 'set_goal';

const id = (...parts) => [NAMESPACE, ...parts].join(':');
const isOurId = (s) => typeof s === 'string' && s.startsWith(`${NAMESPACE}:`);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set_goal')
        .setDescription('Walk through setting a long-term WaniKani goal'),

    async execute(interaction) {
        const apiKey = await getApiKeyForUser(interaction.user.id, interaction.guildId);
        if (!apiKey) {
            return interaction.reply({
                embeds: [error(
                    'No API Key',
                    'Run `/setup apikey:<token>` in a server first so the bot can read your WaniKani data.'
                )],
                flags: MessageFlags.Ephemeral,
            });
        }

        const modal = new ModalBuilder()
            .setCustomId(id('m_init'))
            .setTitle('Set a long-term goal')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('target_level')
                        .setLabel('Target level (2–60)')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(1)
                        .setMaxLength(2)
                        .setPlaceholder('e.g. 40')
                        .setRequired(true),
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('deadline')
                        .setLabel('Deadline (YYYY-MM-DD)')
                        .setStyle(TextInputStyle.Short)
                        .setMinLength(10)
                        .setMaxLength(10)
                        .setPlaceholder('e.g. 2026-12-31')
                        .setRequired(true),
                ),
            );

        await interaction.showModal(modal);
    },

    isOurId,

    async handleModal(interaction) {
        const customId = interaction.customId;
        if (customId === id('m_init')) return handleInitModal(interaction);
        if (customId === id('m_custom')) return handleCustomizeModal(interaction);
    },

    async handleButton(interaction) {
        const [, action, arg] = interaction.customId.split(':');
        if (action === 'p') return handlePaceButton(interaction, arg);
        if (action === 'confirm') return handleConfirmButton(interaction);
        if (action === 'customize') return handleCustomizeButton(interaction);
        if (action === 'cancel') return handleCancelButton(interaction);
    },
};

async function handleInitModal(interaction) {
    const targetLevelStr = interaction.fields.getTextInputValue('target_level').trim();
    const deadline = interaction.fields.getTextInputValue('deadline').trim();
    const targetLevel = Number.parseInt(targetLevelStr, 10);

    if (!isValidLevel(targetLevel)) {
        return interaction.reply({
            embeds: [error('Invalid Level', 'Target level must be an integer from 2 to 60.')],
            flags: MessageFlags.Ephemeral,
        });
    }
    if (!isValidDeadline(deadline)) {
        return interaction.reply({
            embeds: [error('Invalid Deadline', 'Use the format `YYYY-MM-DD` and pick a date at least one day in the future.')],
            flags: MessageFlags.Ephemeral,
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const apiKey = await getApiKeyForUser(interaction.user.id, interaction.guildId);
        if (!apiKey) {
            return interaction.editReply({
                embeds: [error('No API Key', 'Set up the bot in a server first with `/setup`.')],
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
            console.error('[set_goal m_init] WK fetch:', apiErr);
            if (apiErr.message?.includes('401') || apiErr.message?.includes('403')) {
                return interaction.editReply({
                    embeds: [error(
                        'API Key Rejected',
                        'WaniKani rejected your stored token. It may have been revoked. Re-run `/setup apikey:<token>` in a server to refresh it.'
                    )],
                });
            }
            throw apiErr;
        }

        const currentLevel = wkData.userData.level;
        if (targetLevel <= currentLevel) {
            return interaction.editReply({
                embeds: [error('Already Past Target', `You're already at level ${currentLevel}. Pick a target higher than your current level.`)],
            });
        }

        const hitRate = hitRateData?.hitRate ?? DEFAULT_HIT_RATE;
        const options = paceOptionsFor({
            targetLevel,
            currentLevel,
            deadline,
            hitRate,
            personalPace,
        });

        wizard.set(interaction.user.id, {
            targetLevel,
            currentLevel,
            deadline,
            hitRate,
            hitRateSampleSize: hitRateData?.sampleSize ?? 0,
            personalPace,
            chosenPaceKey: null,
            customLessons: null,
            customReviews: null,
        });

        return interaction.editReply({
            embeds: [renderPaceSelectionEmbed({ targetLevel, currentLevel, deadline, hitRate, hitRateSampleSize: hitRateData?.sampleSize ?? 0, options })],
            components: paceButtonRows(options),
        });
    } catch (err) {
        console.error('[set_goal m_init]', err);
        return interaction.editReply({
            embeds: [error('WaniKani Error', 'Could not load your WaniKani data. Try again in a minute.')],
        });
    }
}

async function handlePaceButton(interaction, paceKey) {
    const state = wizard.get(interaction.user.id);
    if (!state) {
        return interaction.update({
            embeds: [error('Wizard Expired', 'Run `/set_goal` again to start over.')],
            components: [],
        });
    }

    const presetMap = Object.fromEntries(
        paceOptionsFor({
            targetLevel: state.targetLevel,
            currentLevel: state.currentLevel,
            deadline: state.deadline,
            hitRate: state.hitRate,
            personalPace: state.personalPace,
        }).map(o => [o.key, o])
    );

    const chosen = presetMap[paceKey];
    if (!chosen) {
        return interaction.update({
            embeds: [error('Unknown Pace', 'Pick one of the offered pace options.')],
            components: [],
        });
    }

    wizard.update(interaction.user.id, {
        chosenPaceKey: paceKey,
        customLessons: null,
        customReviews: null,
    });

    return interaction.update({
        embeds: [renderConfirmEmbed(state, chosen)],
        components: confirmButtonRows(),
    });
}

async function handleCustomizeButton(interaction) {
    const state = wizard.get(interaction.user.id);
    if (!state || !state.chosenPaceKey) {
        return interaction.update({
            embeds: [error('Wizard Expired', 'Run `/set_goal` again to start over.')],
            components: [],
        });
    }

    const presetMap = Object.fromEntries(
        paceOptionsFor({
            targetLevel: state.targetLevel,
            currentLevel: state.currentLevel,
            deadline: state.deadline,
            hitRate: state.hitRate,
            personalPace: state.personalPace,
        }).map(o => [o.key, o])
    );
    const chosen = presetMap[state.chosenPaceKey];

    const modal = new ModalBuilder()
        .setCustomId(id('m_custom'))
        .setTitle('Customize daily targets')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('lessons')
                    .setLabel('Daily lessons')
                    .setStyle(TextInputStyle.Short)
                    .setMinLength(1)
                    .setMaxLength(4)
                    .setValue(String(chosen.projection.lessonsPerDay))
                    .setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('reviews')
                    .setLabel('Daily reviews (estimate)')
                    .setStyle(TextInputStyle.Short)
                    .setMinLength(1)
                    .setMaxLength(4)
                    .setValue(String(chosen.projection.reviewsPerDay))
                    .setRequired(true),
            ),
        );

    await interaction.showModal(modal);
}

async function handleCustomizeModal(interaction) {
    const lessons = Number.parseInt(interaction.fields.getTextInputValue('lessons').trim(), 10);
    const reviews = Number.parseInt(interaction.fields.getTextInputValue('reviews').trim(), 10);

    if (!Number.isInteger(lessons) || lessons < 1 || lessons > 500) {
        return interaction.reply({
            embeds: [error('Invalid Lessons', 'Daily lessons must be an integer between 1 and 500.')],
            flags: MessageFlags.Ephemeral,
        });
    }
    if (!Number.isInteger(reviews) || reviews < 1 || reviews > 2000) {
        return interaction.reply({
            embeds: [error('Invalid Reviews', 'Daily reviews must be an integer between 1 and 2000.')],
            flags: MessageFlags.Ephemeral,
        });
    }

    const state = wizard.get(interaction.user.id);
    if (!state || !state.chosenPaceKey) {
        return interaction.reply({
            embeds: [error('Wizard Expired', 'Run `/set_goal` again to start over.')],
            flags: MessageFlags.Ephemeral,
        });
    }

    wizard.update(interaction.user.id, {
        customLessons: lessons,
        customReviews: reviews,
    });

    const updated = wizard.get(interaction.user.id);
    const presetMap = Object.fromEntries(
        paceOptionsFor({
            targetLevel: updated.targetLevel,
            currentLevel: updated.currentLevel,
            deadline: updated.deadline,
            hitRate: updated.hitRate,
            personalPace: updated.personalPace,
        }).map(o => [o.key, o])
    );
    const chosen = presetMap[updated.chosenPaceKey];

    const customProjection = {
        ...chosen.projection,
        lessonsPerDay: lessons,
        reviewsPerDay: reviews,
    };
    const overrideOption = { ...chosen, projection: customProjection };

    if (interaction.message) {
        await interaction.update({
            embeds: [renderConfirmEmbed(updated, overrideOption, { customized: true })],
            components: confirmButtonRows(),
        });
    } else {
        await interaction.reply({
            embeds: [renderConfirmEmbed(updated, overrideOption, { customized: true })],
            components: confirmButtonRows(),
            flags: MessageFlags.Ephemeral,
        });
    }
}

async function handleConfirmButton(interaction) {
    const state = wizard.get(interaction.user.id);
    if (!state || !state.chosenPaceKey) {
        return interaction.update({
            embeds: [error('Wizard Expired', 'Run `/set_goal` again to start over.')],
            components: [],
        });
    }

    const presetMap = Object.fromEntries(
        paceOptionsFor({
            targetLevel: state.targetLevel,
            currentLevel: state.currentLevel,
            deadline: state.deadline,
            hitRate: state.hitRate,
            personalPace: state.personalPace,
        }).map(o => [o.key, o])
    );
    const chosen = presetMap[state.chosenPaceKey];
    const finalLessons = state.customLessons ?? chosen.projection.lessonsPerDay;
    const finalReviews = state.customReviews ?? chosen.projection.reviewsPerDay;

    const now = new Date().toISOString();
    await db.run(
        `INSERT INTO long_goals (
            user_id, target_level, deadline, pace_mode,
            days_per_level, items_per_level,
            daily_lessons, daily_reviews, hit_rate,
            created_at
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
            interaction.user.id,
            state.targetLevel,
            state.deadline,
            chosen.key,
            chosen.daysPerLevel,
            ITEMS_PER_LEVEL,
            finalLessons,
            finalReviews,
            state.hitRate,
            now,
        ]
    );

    wizard.remove(interaction.user.id);

    return interaction.update({
        embeds: [success(
            'Goal Saved',
            [
                `🎯 **Level ${state.targetLevel} by ${state.deadline}**`,
                `Pace: ${chosen.label} (${chosen.daysPerLevel.toFixed(1)} days/level)`,
                `Daily target: **${finalLessons}** lessons · **${finalReviews}** reviews`,
                '',
                'Use `/goal show` to view progress, `/goal alerts` to enable DM pings.',
            ].join('\n')
        )],
        components: [],
    });
}

async function handleCancelButton(interaction) {
    wizard.remove(interaction.user.id);
    return interaction.update({
        embeds: [base('🚫 Cancelled').setDescription('No goal was saved.')],
        components: [],
    });
}

function renderPaceSelectionEmbed({ targetLevel, currentLevel, deadline, hitRate, hitRateSampleSize, options }) {
    const embed = base('🎯 Choose Your Pace')
        .setDescription(
            [
                `**Target:** Level ${targetLevel} by **${deadline}**`,
                `**Current level:** ${currentLevel}`,
                `**Hit rate (last 30d):** ${(hitRate * 100).toFixed(0)}%${hitRateSampleSize ? ` (${hitRateSampleSize} reviews)` : ' — defaulted'}`,
                '',
                'Pick a pace below. Daily review estimates assume your hit rate stays stable.',
            ].join('\n')
        );

    for (const opt of options) {
        const p = opt.projection;
        const status = p.underWaniKaniMinimum
            ? '⛔ Below WaniKani SRS minimum — not actually achievable'
            : p.feasibleAtPace
                ? `✅ Finishes ~${p.projectedFinish}`
                : `⚠️ Finishes ~${p.projectedFinish} — past deadline`;
        embed.addFields({
            name: `${opt.label} — ${opt.daysPerLevel.toFixed(1)} days/level`,
            value: [
                opt.summary,
                `**${p.lessonsPerDay}** lessons/day · **~${p.reviewsPerDay}** reviews/day`,
                status,
            ].join('\n'),
            inline: false,
        });
    }

    return embed;
}

function renderConfirmEmbed(state, chosenOption, opts = {}) {
    const p = chosenOption.projection;
    const lines = [
        `🎯 **Level ${state.targetLevel} by ${state.deadline}**`,
        `**Current level:** ${state.currentLevel}`,
        `**Pace:** ${chosenOption.label} — ${chosenOption.daysPerLevel.toFixed(1)} days/level`,
        `**Daily target:** ${p.lessonsPerDay} lessons · ~${p.reviewsPerDay} reviews`,
        `**Hit rate factored in:** ${(state.hitRate * 100).toFixed(0)}%`,
        opts.customized ? '*(daily targets customised)*' : '',
        '',
        p.underWaniKaniMinimum
            ? '⛔ This pace is below WaniKani\'s SRS minimum (~6.83 d/level). It\'s not physically achievable.'
            : p.feasibleAtPace
                ? `✅ At this pace you'd finish around ${p.projectedFinish}, ahead of your deadline.`
                : `⚠️ This pace projects finishing ${p.projectedFinish}, past your deadline. Consider a faster pace or extending the date.`,
        '',
        'Confirm to save the goal, customise to override the daily targets, or cancel.',
    ].filter(Boolean);
    return base('Review Your Goal').setDescription(lines.join('\n'));
}

function paceButtonRows(options) {
    const buttons = options.map(opt =>
        new ButtonBuilder()
            .setCustomId(id('p', opt.key))
            .setLabel(opt.labelText || opt.key)
            .setEmoji(opt.emoji || '🎯')
            .setStyle(ButtonStyle.Primary)
    );
    buttons.push(
        new ButtonBuilder()
            .setCustomId(id('cancel'))
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }
    return rows;
}

function confirmButtonRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id('confirm')).setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(id('customize')).setLabel('Customise').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(id('cancel')).setLabel('Cancel').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
        ),
    ];
}
