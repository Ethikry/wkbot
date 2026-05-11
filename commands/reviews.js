const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getCompletedSince, getWaniKaniData } = require('../helpers/wanikaniData');
const { getAccountForDiscordUser } = require('../helpers/userLink');
const { base, error } = require('../helpers/embeds');
const { recordPoll } = require('../helpers/zerostate');
const { DEFAULT_TIME_ZONE, botDateKey, resolveTimeZone, startOfBotDayUtcIso } = require('../helpers/botTime');
const db = require('../db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reviews')
        .setDescription('Show your current WaniKani lessons and reviews')
        .setDMPermission(false),

    async execute(interaction) {
        const userId = interaction.user.id;
        const guildId = interaction.guild.id;
        const username = interaction.member?.displayName ?? interaction.user.displayName;

        const account = await getAccountForDiscordUser(userId);
        if (!account?.api_token_encrypted) {
            return interaction.reply({
                embeds: [error('No API Key', 'Set your WaniKani key with `/setup apikey:<token>` first.')],
                flags: MessageFlags.Ephemeral,
            });
        }

        await db.run(
            `INSERT OR IGNORE INTO guild_settings (guild_id, timezone) VALUES (?, ?)`,
            [guildId, DEFAULT_TIME_ZONE]
        );
        await db.run(
            `INSERT OR IGNORE INTO guild_members (guild_id, discord_user_id) VALUES (?, ?)`,
            [guildId, userId]
        );

        await interaction.deferReply();

        try {
            const settings = await db.get(`SELECT timezone FROM guild_settings WHERE guild_id = ?`, [guildId]);
            const timeZone = resolveTimeZone(settings?.timezone);
            const today = botDateKey(new Date(), timeZone);
            const dayStart = startOfBotDayUtcIso(today, timeZone);

            const [data, completed] = await Promise.all([
                getWaniKaniData(account),
                getCompletedSince(account, dayStart),
            ]);

            await recordPoll(userId, guildId, data.dueRightNow, account.wanikani_user_id).catch(err =>
                console.error('[reviews recordPoll]', err.message)
            );

            const embed = base(`📚 ${username}'s Reviews`)
                .setURL('https://www.wanikani.com/dashboard')
                .setDescription([
                    '**Available now**',
                    `Level: **${data.userData.level}**`,
                    `Lessons: **${data.pendingLessons}**`,
                    `Reviews: **${data.dueRightNow}**`,
                    '',
                    '**Completed today**',
                    `Lessons: **${completed.lessonsCompleted}** · Reviews: **${completed.reviewsCompleted}**`,
                ].join('\n'));

            if (data.userData.current_vacation_started_at) {
                embed.addFields({ name: 'Status', value: '🏖️ Vacation mode is active.', inline: false });
            }

            return interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error('[reviews]', err);
            return interaction.editReply({
                embeds: [error('WaniKani API Error', 'Could not fetch your review counts. Make sure your API key is still valid.')],
            });
        }
    },
};
