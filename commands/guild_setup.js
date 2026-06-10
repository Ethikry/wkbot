const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { success, error, base } = require('../helpers/embeds');
const db = require('../db');

// Per-guild personal preferences. Personal DM preferences (reviews_dm, streak,
// shame DMs) live cross-guild under `/setup`. This command only controls how
// the *current server's* channel posts treat the user — whether to @mention,
// whether their queue clears / burns appear in the daily recap's Highlights,
// whether to announce level-ups, and whether to include shame about them in
// this server's daily/weekly posts.
//
// Guild admins still need to enable each feature server-wide via `/config`
// before any per-user opt-in here has any effect.

const FIELDS = [
    {
        option: 'mention',
        column: 'reviews_ping_enabled',
        description: '@mention me in the daily recap and weekly leaderboard posts',
        label: 'Daily/weekly @mention',
        defaultValue: 1,
    },
    {
        option: 'cleared',
        column: 'cleared_enabled',
        description: "Include my queue clears in this server's daily recap",
        label: 'Recap: queue clears',
        defaultValue: 1,
    },
    {
        option: 'burn',
        column: 'burn_announcement_enabled',
        description: "Include my burns in this server's daily recap",
        label: 'Recap: burns',
        defaultValue: 1,
    },
    {
        option: 'levelup',
        column: 'levelup_announcement_enabled',
        description: 'Announce my level-ups in this server',
        label: 'Level-up announcement',
        defaultValue: 1,
    },
    {
        option: 'shame',
        column: 'shame_enabled',
        description: 'Include shame about me in this server\'s daily/weekly posts',
        label: 'Channel shame',
        defaultValue: 0,
    },
];

module.exports = {
    data: (() => {
        const cmd = new SlashCommandBuilder()
            .setName('guild_setup')
            .setDescription('Configure your per-server preferences (channel pings, announcements, shame in posts)')
            .setDMPermission(false);
        for (const f of FIELDS) {
            cmd.addBooleanOption(opt =>
                opt.setName(f.option).setDescription(f.description).setRequired(false)
            );
        }
        return cmd;
    })(),

    async execute(interaction) {
        const discordUserId = interaction.user.id;
        const guildId = interaction.guild.id;

        // Require an account linked first — otherwise these flags don't apply
        // to anything yet.
        const account = await db.get(
            `SELECT wanikani_user_id FROM wanikani_accounts WHERE discord_user_id = ?`,
            [discordUserId]
        );
        if (!account) {
            return interaction.reply({
                embeds: [error('Not Linked', 'Run `/setup apikey:<token>` first to link your WaniKani account.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        // Make sure (guild_id, discord_user_id) row exists for FK.
        await db.run(
            `INSERT OR IGNORE INTO guild_members (guild_id, discord_user_id) VALUES (?, ?)`,
            [guildId, discordUserId]
        );

        const inputs = Object.fromEntries(
            FIELDS.map(f => [f.option, interaction.options.getBoolean(f.option)])
        );
        const anyProvided = FIELDS.some(f => inputs[f.option] !== null);

        const cols = FIELDS.map(f => f.column).join(', ');
        const existing = await db.get(
            `SELECT ${cols} FROM reminder_settings WHERE guild_id = ? AND discord_user_id = ?`,
            [guildId, discordUserId]
        );

        const resolved = Object.fromEntries(
            FIELDS.map(f => {
                const opt = inputs[f.option];
                if (opt !== null) return [f.column, opt ? 1 : 0];
                return [f.column, existing?.[f.column] ?? f.defaultValue];
            })
        );

        await db.run(
            `INSERT INTO reminder_settings
                (guild_id, discord_user_id, ${cols})
             VALUES (?, ?, ${FIELDS.map(() => '?').join(', ')})
             ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
                ${FIELDS.map(f => `${f.column} = excluded.${f.column}`).join(', ')},
                updated_at = CURRENT_TIMESTAMP`,
            [guildId, discordUserId, ...FIELDS.map(f => resolved[f.column])]
        );

        if (!anyProvided) {
            return interaction.reply({
                embeds: [showGuildSettings(resolved)],
                flags: MessageFlags.Ephemeral,
            });
        }

        const lines = FIELDS
            .filter(f => inputs[f.option] !== null)
            .map(f => `${f.label}: **${resolved[f.column] ? 'enabled' : 'disabled'}**.`);
        return interaction.reply({
            embeds: [success('Server Settings Updated', lines.join('\n'))],
            flags: MessageFlags.Ephemeral,
        });
    },
};

function showGuildSettings(values) {
    const embed = base('⚙️ Your Settings (this server)');
    for (const f of FIELDS) {
        embed.addFields({ name: f.label, value: values[f.column] ? 'enabled' : 'disabled', inline: true });
    }
    embed.addFields({
        name: 'Cross-server settings',
        value: 'Run `/setup` for DM-style preferences (reviews-available, streak risk, shame DMs).',
        inline: false,
    });
    return embed;
}
