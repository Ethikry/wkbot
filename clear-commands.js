require("dotenv").config();
const { installConsoleLogger } = require("./helpers/logger");
installConsoleLogger();

const { REST, Routes } = require("discord.js");

const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID; // optional

if (!token || !clientId) {
  throw new Error("Missing TOKEN or CLIENT_ID in .env");
}

const rest = new REST({ version: "10" }).setToken(token);

async function main() {
  // Clear global commands
  await rest.put(Routes.applicationCommands(clientId), { body: [] });
  console.log("Deleted all global commands.");

  // Clear guild commands, if provided
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
    console.log(`Deleted all guild commands for ${guildId}.`);
  }
}

main().catch(console.error);
