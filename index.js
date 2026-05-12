require('dotenv').config();
const { installConsoleLogger } = require('./helpers/logger');
installConsoleLogger();

process.on('warning', warning => {
    console.warn('[process warning]', warning);
});
process.on('unhandledRejection', reason => {
    console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', err => {
    console.error('[uncaughtException]', err);
    process.exit(1);
});

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, Events, MessageFlags } = require('discord.js');
const db = require('./db');
const { scheduleAll } = require('./scheduler');
const { startHealthServer } = require('./server');
const { warnIfMissing } = require('./helpers/crypto');
const { error: errorEmbed } = require('./helpers/embeds');
const { recordCommandStart, recordCommandFinish } = require('./helpers/commandUsage');
const { startInteractionStateRefresh } = require('./helpers/interactionState');

async function main() {
    if (!process.env.TOKEN) {
        console.error('TOKEN is not set in environment.');
        process.exit(1);
    }

    warnIfMissing();

    try {
        await db.init();
        console.log('Database ready');
    } catch (err) {
        console.error('Database init failed:', err);
        process.exit(1);
    }

    const client = new Client({
        intents: [GatewayIntentBits.Guilds],
    });
    client.on('error', err => console.error('[discord/client error]', err));
    client.on('warn', warning => console.warn('[discord/client warn]', warning));
    client.on('shardError', err => console.error('[discord/shard error]', err));

    client.commands = new Collection();
    const commandsDir = path.join(__dirname, 'commands');
    for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
        const cmd = require(path.join(commandsDir, file));
        if (!cmd?.data?.name || typeof cmd.execute !== 'function') {
            console.warn(`[commands] Skipping ${file} — missing data.name or execute()`);
            continue;
        }
        client.commands.set(cmd.data.name, cmd);
    }
    console.log(`Loaded ${client.commands.size} commands`);

    client.once(Events.ClientReady, async (readyClient) => {
        console.log(`Logged in as ${readyClient.user.tag}`);
        try {
            await scheduleAll(readyClient);
            console.log('Schedules initialized');
        } catch (err) {
            console.error('Scheduling failed:', err);
        }
    });

    const findHandlerForCustomId = (customId, kind) => {
        if (!customId) return null;
        for (const cmd of client.commands.values()) {
            if (typeof cmd.isOurId === 'function' && cmd.isOurId(customId)) {
                return cmd[kind] ? { command: cmd, handler: cmd[kind] } : null;
            }
        }
        return null;
    };

    const handleInteraction = async (interaction) => {
        let commandUsageId = null;
        let commandStartedAtMs = null;
        try {
            if (interaction.isChatInputCommand()) {
                const command = client.commands.get(interaction.commandName);
                if (!command) return;
                commandStartedAtMs = Date.now();
                commandUsageId = await recordCommandStart(interaction).catch(err => {
                    console.error('[commandUsage/start]', err);
                    return null;
                });
                const stateRefresh = startInteractionStateRefresh(interaction);
                stateRefresh?.catch(err => console.error(`[stateRefresh/${interaction.commandName}]`, err));
                await command.execute(interaction, client);
                await recordCommandFinish(commandUsageId, {
                    status: 'success',
                    startedAtMs: commandStartedAtMs,
                }).catch(err => console.error('[commandUsage/finish]', err));
                return;
            }
            if (interaction.isButton()) {
                const found = findHandlerForCustomId(interaction.customId, 'handleButton');
                if (!found) return;
                await found.handler.call(found.command, interaction, client);
                return;
            }
            if (interaction.isModalSubmit()) {
                const found = findHandlerForCustomId(interaction.customId, 'handleModal');
                if (!found) return;
                await found.handler.call(found.command, interaction, client);
                return;
            }
        } catch (err) {
            await recordCommandFinish(commandUsageId, {
                status: 'failed',
                startedAtMs: commandStartedAtMs,
                error: err,
            }).catch(finishErr => console.error('[commandUsage/finish]', finishErr));
            const label = interaction.isChatInputCommand?.()
                ? `/${interaction.commandName}`
                : interaction.customId
                    ? `[component ${interaction.customId}]`
                    : '[unknown interaction]';
            console.error(`[interaction] ${label}:`, err);
            const payload = {
                embeds: [errorEmbed('Command Failed', 'Something went wrong while running that command.')],
                flags: MessageFlags.Ephemeral,
            };
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp(payload);
                } else if (interaction.isRepliable?.()) {
                    await interaction.reply(payload);
                }
            } catch (replyErr) {
                console.error('[interaction] failed to send error reply:', replyErr);
            }
        }
    };

    client.on(Events.InteractionCreate, handleInteraction);

    startHealthServer({
        getStatus: () => ({
            discord: client.isReady() ? 'ready' : 'connecting',
            guildCount: client.guilds?.cache?.size ?? 0,
        }),
    });

    await client.login(process.env.TOKEN);

    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Received ${signal}, shutting down...`);
        try { client.destroy(); } catch { /* ignore */ }
        try { await db.close(); } catch { /* ignore */ }
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
