require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

if (!process.env.TOKEN) {
    console.error('TOKEN is not set.');
    process.exit(1);
}
if (!process.env.CLIENT_ID) {
    console.error('CLIENT_ID is not set.');
    process.exit(1);
}

const commands = [];
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
    const cmd = require(path.join(commandsDir, file));
    if (!cmd?.data) {
        console.warn(`[deploy] skipping ${file} — no data export`);
        continue;
    }
    commands.push(cmd.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        const route = process.env.GUILD_ID
            ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
            : Routes.applicationCommands(process.env.CLIENT_ID);
        const target = process.env.GUILD_ID ? `guild ${process.env.GUILD_ID}` : 'global';
        console.log(`Deploying ${commands.length} commands to ${target}...`);
        await rest.put(route, { body: commands });
        console.log('Deployed.');
    } catch (err) {
        console.error('Deploy failed:', err);
        process.exit(1);
    }
})();
