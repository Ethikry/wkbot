const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { success, error, base } = require('../helpers/embeds');
const { normalizeTimeZone, isValidTimeZone, resolveTimeZone, getBotTimeZone } = require('../helpers/botTime');
const { getEffectiveUserTimeZone } = require('../helpers/tzInfer');
const db = require('../db');

// Personal timezone override. The bot infers a zone from activity patterns
// (see helpers/tzInfer.js); this command lets a user pin the real one, which
// always wins over the inference. Discord caps a string option at 25 choices,
// so the dropdown carries 24 common zones plus "Clear override" — anything
// else goes through the free-text `custom` option.
const ZONE_CHOICES = [
    { name: 'UTC', value: 'UTC' },
    { name: 'PST/PDT — US Pacific (Los Angeles)', value: 'America/Los_Angeles' },
    { name: 'MST/MDT — US Mountain (Denver)', value: 'America/Denver' },
    { name: 'CST/CDT — US Central (Chicago)', value: 'America/Chicago' },
    { name: 'EST/EDT — US Eastern (New York)', value: 'America/New_York' },
    { name: 'AKST/AKDT — Alaska (Anchorage)', value: 'America/Anchorage' },
    { name: 'HST — Hawaii (Honolulu)', value: 'Pacific/Honolulu' },
    { name: 'AST/ADT — Atlantic (Halifax)', value: 'America/Halifax' },
    { name: 'GMT/BST — UK (London)', value: 'Europe/London' },
    { name: 'WET/WEST — Portugal (Lisbon)', value: 'Europe/Lisbon' },
    { name: 'CET/CEST — Central Europe (Paris)', value: 'Europe/Paris' },
    { name: 'EET/EEST — Eastern Europe (Helsinki)', value: 'Europe/Helsinki' },
    { name: 'MSK — Russia (Moscow)', value: 'Europe/Moscow' },
    { name: 'IST — India (Kolkata)', value: 'Asia/Kolkata' },
    { name: 'ICT — Thailand/Vietnam (Bangkok)', value: 'Asia/Bangkok' },
    { name: 'SGT — Singapore', value: 'Asia/Singapore' },
    { name: 'HKT — Hong Kong', value: 'Asia/Hong_Kong' },
    { name: 'PHT — Philippines (Manila)', value: 'Asia/Manila' },
    { name: 'JST — Japan (Tokyo)', value: 'Asia/Tokyo' },
    { name: 'KST — Korea (Seoul)', value: 'Asia/Seoul' },
    { name: 'AWST — Western Australia (Perth)', value: 'Australia/Perth' },
    { name: 'ACST/ACDT — Central Australia (Adelaide)', value: 'Australia/Adelaide' },
    { name: 'AEST/AEDT — Eastern Australia (Sydney)', value: 'Australia/Sydney' },
    { name: 'NZST/NZDT — New Zealand (Auckland)', value: 'Pacific/Auckland' },
    { name: 'Clear override (use auto-detected)', value: 'clear' },
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('timezone')
        .setDescription('Set your personal timezone, or see what the bot detected for you')
        .addStringOption(opt =>
            opt.setName('zone')
                .setDescription('Pick a timezone (or clear your override)')
                .setRequired(false)
                .addChoices(...ZONE_CHOICES)
        )
        .addStringOption(opt =>
            opt.setName('custom')
                .setDescription('Any IANA zone or abbreviation not in the list, e.g. America/Sao_Paulo or NST')
                .setRequired(false)
        ),

    async execute(interaction) {
        const zoneOpt = interaction.options.getString('zone');
        const customOpt = interaction.options.getString('custom');
        const discordUserId = interaction.user.id;

        if (zoneOpt === 'clear') {
            await db.run(
                `INSERT INTO user_reminder_settings (discord_user_id, timezone)
                 VALUES (?, NULL)
                 ON CONFLICT(discord_user_id) DO UPDATE SET
                    timezone = NULL,
                    updated_at = CURRENT_TIMESTAMP`,
                [discordUserId]
            );
            const effective = await getCurrentState(interaction);
            return interaction.reply({
                embeds: [success('Timezone Override Cleared', describeState(effective))],
                flags: MessageFlags.Ephemeral,
            });
        }

        const requested = customOpt ?? zoneOpt;
        if (requested) {
            const zone = normalizeTimeZone(requested.trim());
            if (!isValidTimeZone(zone)) {
                return interaction.reply({
                    embeds: [error(
                        'Unknown Timezone',
                        `\`${requested}\` isn't a timezone I recognize. Use an IANA name like \`America/Sao_Paulo\` or a common abbreviation like \`JST\`, \`PST\`, \`CET\`.`
                    )],
                    flags: MessageFlags.Ephemeral,
                });
            }
            await db.run(
                `INSERT INTO user_reminder_settings (discord_user_id, timezone)
                 VALUES (?, ?)
                 ON CONFLICT(discord_user_id) DO UPDATE SET
                    timezone = excluded.timezone,
                    updated_at = CURRENT_TIMESTAMP`,
                [discordUserId, zone]
            );
            return interaction.reply({
                embeds: [success(
                    'Timezone Set',
                    `Your timezone is now **${zone}** (local time: ${localTime(zone)}).\n` +
                    'This applies to your daily review/lesson day boundaries and sleep hours, and overrides anything the bot auto-detects.'
                )],
                flags: MessageFlags.Ephemeral,
            });
        }

        const state = await getCurrentState(interaction);
        return interaction.reply({
            embeds: [base('🌐 Your Timezone').setDescription(describeState(state))],
            flags: MessageFlags.Ephemeral,
        });
    },
};

async function getCurrentState(interaction) {
    const discordUserId = interaction.user.id;
    let fallbackTz = getBotTimeZone();
    if (interaction.guildId) {
        const row = await db.get(
            `SELECT timezone FROM guild_settings WHERE guild_id = ?`,
            [interaction.guildId]
        );
        fallbackTz = resolveTimeZone(row?.timezone);
    }
    return getEffectiveUserTimeZone(discordUserId, fallbackTz);
}

function localTime(zone) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hour: 'numeric',
        minute: '2-digit',
        weekday: 'short',
    }).format(new Date());
}

function describeState(state) {
    const time = localTime(state.timeZone);
    switch (state.source) {
        case 'override':
            return `**${state.timeZone}** (local time: ${time})\nSet by you — clear it with \`/timezone zone:Clear override\` to go back to auto-detection.`;
        case 'inferred':
            return `**${state.timeZone}** (local time: ${time})\nAuto-detected from your activity patterns (confidence ${(state.confidence * 100).toFixed(0)}%). Set one with \`/timezone\` if this is wrong.`;
        default:
            return `**${state.timeZone}** (local time: ${time})\nUsing the server default — the bot hasn't seen enough activity to detect your timezone yet. Set one with \`/timezone\`.`;
    }
}
