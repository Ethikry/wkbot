const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { base } = require('../helpers/embeds');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('How to use the WaniKani bot'),

    async execute(interaction) {
        const embed = base('WaniKani Bot — Commands')
            .setDescription('Track your WaniKani progress and study with the rest of the server.')
            .addFields(
                {
                    name: '👤 Personal',
                    value: [
                        '`/setup` — register your read-only WaniKani API token, toggle daily pings + shame',
                        '`/wkstats` — level progress, lessons, reviews, SRS breakdown, 30-day heatmap',
                        '`/streak` — current and longest review streak',
                        '`/mistakes` — your missed reviews from the past 7 days (answers in spoilers)',
                        '`/vacation` — sync ping setting with WK vacation status',
                        '`/forget` — delete all your data in this server',
                    ].join('\n'),
                },
                {
                    name: '🎯 Goals (works in DMs)',
                    value: [
                        '`/goals` — view your current goals and pace, then:',
                        '  **Set a goal** — long-term wizard (DMs) or daily targets for this server',
                        '  **Configure alerts** — opt in/out of DM pings (pace, reviews piling up)',
                        '  **Clear goal** — remove all your goals',
                    ].join('\n'),
                },
                {
                    name: '🌐 Shared',
                    value: [
                        '`/leaderboard` — past 7 days, ranked by reviews',
                        '`/kanji` — random kanji from your current level',
                    ].join('\n'),
                },
                {
                    name: '🛠️ Moderator — `/config`',
                    value: [
                        '`/config` (no args) — view current settings',
                        'Optional params (set any combination in one call):',
                        '`burn` `levelup` `reviews_cleared` — toggle announcements',
                        '`daily` `daily_time` — daily summary on/off + time',
                        '`weekly` `weekly_day` `weekly_time` — leaderboard schedule',
                        '`channel` `modrole` — output channel/thread, mod role',
                    ].join('\n'),
                },
            );

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
