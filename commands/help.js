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
                        '`/setup` — register your read-only WaniKani API token, toggle daily pings',
                        '`/wkstats` — level progress, lessons, reviews, SRS breakdown, 30-day heatmap',
                        '`/streak` — current and longest review streak',
                        '`/daily_goal` — set lessons / reviews / "clear queue" daily targets (auto-set if `/goal` is in place)',
                        '`/mistakes` — your missed reviews from the past 7 days (answers in spoilers)',
                        '`/vacation` — sync ping setting with WK vacation status',
                        '`/forget` — delete all your data in this server',
                    ].join('\n'),
                },
                {
                    name: '🎯 Long-term Goal (works in DMs)',
                    value: [
                        '`/set_goal` — interactive wizard to plan your level-up pace',
                        '`/goal show` — current goal + on-pace status',
                        '`/goal alerts` — opt in to DM pings (daily pace, reviews piling up)',
                        '`/goal clear` — remove your goal',
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
                        '`/config show` — view current settings',
                        '`/config channel` — set output channel or thread',
                        '`/config timezone` `/config modrole`',
                        '`/config daily | morning | shame | leaderboard`',
                        '`/config levelups | burns`',
                    ].join('\n'),
                },
            );

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
