require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, Events, MessageFlags } = require('discord.js');
const db = require('./db');
const { scheduleAll } = require('./scheduler');
const { startHealthServer } = require('./server');
const { warnIfMissing } = require('./helpers/crypto');
const { error: errorEmbed } = require('./helpers/embeds');

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

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        try {
            await command.execute(interaction, client);
        } catch (err) {
            console.error(`[interaction] /${interaction.commandName}:`, err);
            const payload = {
                embeds: [errorEmbed('Command Failed', 'Something went wrong while running that command.')],
                flags: MessageFlags.Ephemeral,
            };
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp(payload);
                } else {
                    await interaction.reply(payload);
                }
            } catch (replyErr) {
                console.error('[interaction] failed to send error reply:', replyErr.message);
            }
        }
    });

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
    process.on('unhandledRejection', (reason) => {
        console.error('[unhandledRejection]', reason);
    });
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
