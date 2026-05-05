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
                        '`/wkstats` — your level, lessons, reviews, and SRS-stage breakdown',
                        '`/streak` — your current and longest review streak',
                        '`/goal` — set or view your daily lesson/review targets',
                        '`/vacation` — sync ping setting with WK vacation status',
                        '`/forget` — delete all your data in this server',
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
                    name: '🛠️ Moderator',
                    value: [
                        '`/config show` — view current server settings',
                        '`/config channel` — set bot output channel',
                        '`/config daily` `/config morning` `/config shame` — schedule pings',
                        '`/config leaderboard` — schedule weekly leaderboard',
                        '`/config timezone` — set IANA timezone for schedules',
                        '`/config modrole` — set the role allowed to run `/config`',
                        '`/config levelups` `/config burns` — toggle milestone announcements',
                    ].join('\n'),
                },
            );

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
