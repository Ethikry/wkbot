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
                        '`/setup` — link your read-only WaniKani API token; toggle DM reminders and shame',
                        '`/reviews` — current lessons and reviews, plus today\'s completed counts',
                        '`/wkstats` — level progress, lessons, reviews, SRS breakdown, 30-day heatmap',
                        '`/streak` — current and longest review streak',
                        '`/mistakes` — items you missed in the past 7 days (answers in spoilers)',
                        '`/achievements` — your unlocked WaniKani achievements',
                        '`/sync` — refresh your WK data right now instead of waiting for the daily update',
                        '`/vacation` — sync your daily-ping setting with WK vacation status',
                        '`/reminders` — view your reminder preferences and recent reminder history',
                        '`/forget` — delete all your data stored by this bot in this server',
                    ].join('\n'),
                },
                {
                    name: '🎯 Goals (works in DMs)',
                    value: [
                        '`/goals` — view your goal, pace, and goal streak, then:',
                        '  **Set level target** — long-term wizard (DMs): target level + deadline → lessons/day pace',
                        '  **Daily lessons** / **Clear queue daily** — your two daily commitments, checked in the daily recap',
                        '  **Configure alerts** — opt in/out of pace-alert DMs',
                        '  **Clear goal** — remove your goal',
                    ].join('\n'),
                },
                {
                    name: '🌐 Shared',
                    value: '`/leaderboard` — this week\'s WaniKani leaderboard, ranked by reviews',
                },
                {
                    name: '🛠️ Moderator',
                    value: [
                        '`/config` (no args) — view current server settings',
                        'Options (combine any in one call):',
                        '`levelup` — toggle level-up announcements',
                        '`burn` `cleared` — toggle the burns / queue-clears sections of the daily recap',
                        '`daily` — daily recap on/off',
                        '`weekly` `weekly_day` — leaderboard on/off + day of week',
                        '`time` — time for all scheduled messages (HH:MM, server timezone)',
                        '`timezone` — IANA timezone (e.g. `Asia/Tokyo`, `America/Denver`)',
                        '`channel` `modrole` — output channel/thread, mod role',
                    ].join('\n'),
                },
            );

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
