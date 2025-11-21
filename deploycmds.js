import { REST, Routes } from "discord.js";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import "dotenv/config";
const commands = [];
// Grab all the command folders from the commands directory you created earlier
const foldersPath = path.join(__dirname, "commands");
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
   const commandsPath = path.join(foldersPath, folder);
   const commandFiles = fs
      .readdirSync(commandsPath)
      .filter((file) => file.endsWith(".js"));
   for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      const command = await import(pathToFileURL(filePath).toString());
      if ("data" in command && "execute" in command) {
         const json = command.data.toJSON();
         json.contexts = [0, 1, 2];
         json.integration_types = [0, 1];
         commands.push(json);
      } else {
         console.log(
            `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`
         );
      }
   }
}

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(process.env.TOKEN);

// and deploy your commands!
(async () => {
   try {
      console.log(
         `Started refreshing ${commands.length} application (/) commands.`
      );

      // The put method is used to fully refresh all commands in the guild with the current set
      const data = await rest.put(
         Routes.applicationCommands(process.env.CLIENT_ID),
         { body: commands }
      );

      console.log(
         `Successfully reloaded ${data.length} application (/) commands.`
      );
   } catch (error) {
      // And of course, make sure you catch and log any errors!
      console.error(error);
   }
})();
