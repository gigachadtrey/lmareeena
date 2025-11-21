import {
   SlashCommandBuilder,
   ContainerBuilder,
   TextDisplayBuilder,
   MediaGalleryBuilder,
   SeparatorBuilder,
   MessageFlags,
   ChatInputCommandInteraction,
   AutocompleteInteraction,
   MediaGalleryItemBuilder,
   AttachmentBuilder,
   FileBuilder,
   Attachment,
   ActionRowBuilder,
   ButtonComponent,
   ButtonBuilder,
   ButtonStyle,
   Message,
   Client,
   ChannelFlagsBitField,
   CommandInteraction,
   ButtonInteraction,
   DMChannel
} from "discord.js";
import { spawnSync } from "node:child_process";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LMArena, Chat } from "../../lib/LMArena.mjs"; // typedef
import { getLMArena } from "../../lib/LMArenaSingleton.mjs";
import { Logger } from "../../lib/OPLogger.mjs";
import { generateSupportId, getLogsForSupportId } from "../../lib/util.mjs";
import { fileTypeFromBuffer } from "file-type";
import { mimeToExt } from "mime-detect";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const __dirname = import.meta.dirname;

/**
 * @type {LMArena}
 */
let lmArena;

/**
 * @type {Logger}
 */
let userLogger;

if (process.env.IS_REAL === "YES") {
   lmArena = await getLMArena();
   userLogger = new Logger("command-usage");
}

const superusers = ["612909238997483520"];

/**
 * @typedef {Object} TurnMetadata
 * @property {string} modelUsed
 * @property {string} userPrompt
 * @property {Attachment?} visionAttachment
 * @property {boolean} hasVision
 */

/**
 * @typedef {Object} ArenaAttachment
 * @property {string} mime
 * @property {Buffer} content
 * @property {string | null} r2Key
 * @property {string | null} r2BucketUrl
 */

/**
 * @typedef {Object} ArenaMessage
 * @property {"user" | "system" | "assistant"} role
 * @property {string} content
 * @property {Array<ArenaAttachment>} attachments
 * @property {string?} id - Nullable since in here it's just autofilled by the session manager
 */

/**
 * @typedef {Object} MessageRef Serializable form of a Message, requires a Client to convert back to Message
 * @property {string} channelId
 * @property {string} messageId
 */

/**
 * Convert Message to MessageRef
 * @param {Message<boolean>} m Message
 * @returns {MessageRef}
 */
const msgToRef = (m) => ({ channelId: m.channelId, messageId: m.id });

/**
 * Convert MessageRef to Message
 * @param {MessageRef} ref Reference
 * @param {Client} client Interaction Client
 * @returns {Promise<Message<boolean>>}
 */
const refToMsg = async (ref, client) => {
   const channel = await client.channels.fetch(ref.channelId);
   if (!channel.isTextBased()) {
      return null;
   }
   const us = await channel.messages.fetch(ref.messageId);
   return us;
};

/**
 * @typedef {Object} UserMessage
 * @property {import("discord.js").Interaction} interaction - Message in Discord connected to this chat
 * @property {Chat} lmChat
 * @property {TurnMetadata} meta
 * @property {ArenaMessage} message
 * @property {Object} logging - Logging metadata (i am not making a typedef for this one)
 */

/**
 * @type {Map<string, UserMessage>}
 */
const userMessagesMap = new Map();

export const data = new SlashCommandBuilder()
   .setName("lmarena")
   .setDescription("Inference commands")
   .addSubcommand((sc) =>
      sc
         .setName("text-gen")
         .setDescription("Generate text from a prompt")
         .addStringOption((opt) =>
            opt
               .setName("model")
               .setDescription("model to use")
               .setAutocomplete(true)
               .setRequired(true)
         )
         .addStringOption((opt) =>
            opt
               .setName("prompt")
               .setDescription("your prompt")
               .setRequired(true)
         )
         .addStringOption((opt) =>
            opt
               .setName("system")
               .setDescription("system prompt")
               .setRequired(false)
         )
         .addAttachmentOption((opt) =>
            opt
               .setName("vision")
               .setDescription("vision attachment")
               .setRequired(false)
         )
   )
   .addSubcommand((sc) =>
      sc
         .setName("image-gen")
         .setDescription("Generate an image from a prompt and/or an image")
         .addStringOption((opt) =>
            opt
               .setName("model")
               .setDescription("model to use")
               .setAutocomplete(true)
               .setRequired(true)
         )
         .addStringOption((opt) =>
            opt
               .setName("prompt")
               .setDescription("your prompt")
               .setRequired(true)
         )
         .addAttachmentOption((opt) =>
            opt
               .setName("image")
               .setDescription("image attachment")
               .setRequired(false)
         )
   )
   .addSubcommand((sc) =>
      sc
         .setName("reset-token")
         .setDescription("try to get a new arena auth token (su only)")
   )
   .addSubcommand((sc) =>
      sc
         .setName("r2")
         .setDescription("upload files to lmarena's R2 bucket")
         .addAttachmentOption((opt) =>
            opt
               .setName("file")
               .setDescription("file to upload")
               .setRequired(true)
         )
   )
   .addSubcommand((sc) =>
      sc.setName("refresh-models").setDescription("refresh the models list")
   )
   .addSubcommand((sc) =>
      sc
         .setName("model-info")
         .setDescription("get all information for a model")
         .addStringOption((opt) =>
            opt
               .setName("model")
               .setDescription("model to query")
               .setAutocomplete(true)
               .setRequired(true)
         )
   )
   .addSubcommand((sc) =>
      sc.setName("anon-models").setDescription("list anonymous models")
   )
   .addSubcommand((sc) =>
      sc
         .setName("fetch-log")
         .setDescription("fetch logs for a support ID (su only)")
         .addStringOption((opt) =>
            opt
               .setName("support-id")
               .setDescription("Support ID")
               .setRequired(true)
         )
   )
   .addSubcommand((sc) =>
      sc
         .setName("filter-models")
         .setDescription("fetch models by capability (must provide at least one)")
         .addStringOption((opt) =>
            opt
               .setName("input-modality")
               .setDescription("Comma-separated input modality types to filter by. Options: text, image")
               .setRequired(false)
         )
         .addStringOption((opt) =>
            opt
               .setName("output-modality")
               .setDescription("Comma-separated output modality types to filter by. Options: text, image, video, search")
               .setRequired(false)
         )
   );

// Oneliner: If the string is over 250 chars, trim it and add ellipses at the end
const trimString = (str) => {
   if (str.length > 500) {
      return str.substring(0, 497) + "...";
   } else {
      return str;
   }
};

async function performInferenceTextMode(umid, isRetry = false) {
   const {
      interaction,
      lmChat: chat,
      message,
      meta,
      logging
   } = userMessagesMap.get(umid);
   let editReply = (options) => {
      return interaction.editReply(options);
   };

   await editReply("`0 tokens | 0 tok/sec | 0s elapsed`");
   const { hasVision, visionAttachment, userPrompt, modelUsed } = meta;
   let lastMsgUpdate = Date.now();

   let messageBeganAt = 0;

   let tokensGenerated = 0;
   let toksPerSec = 0;

   let responseText = "";

   let updateMsg = async () => {
      const timeSinceStart = (Date.now() - messageBeganAt) / 1000;
      await editReply(
         `\`${tokensGenerated} tokens | ${toksPerSec.toFixed(2)} tok/sec | ${timeSinceStart.toFixed(2)}s elapsed\``
      );
   };

   console.log("-------------------------------");
   for await (const chunk of chat.sendMessage(message, isRetry)) {
      if (chunk.event === "a0") {
         if (messageBeganAt === 0) messageBeganAt = Date.now(); // Time to first token
         tokensGenerated++;
         const elapsedSeconds = (Date.now() - messageBeganAt) / 1000;
         toksPerSec = tokensGenerated / elapsedSeconds;

         responseText += chunk.data;
         process.stdout.write(chunk.data);

         // Fire async function without blocking the generator
         const now = Date.now();
         if ((now - lastMsgUpdate) / 1000 >= 2) {
            lastMsgUpdate = now;
            updateMsg().catch((err) =>
               console.error("Async task failed:", err)
            );
         }
      } else if (chunk.event === "a3") {
         // 20/11/25 - a3 now provides an error message
         responseText += `A backend error occurred: ${chunk.data}`; 
         userLogger.debug(
            JSON.stringify({
               event: "textGenerationFailure",
               ...logging,
               failureReason: "provider-based error"
            })
         );
      } else if (chunk.event === "ad") {
         break;
      } else if (chunk.event === "c0") {
         // Same as a0 but for when LMArena rejects the message (for logging)
         if (messageBeganAt === 0) messageBeganAt = Date.now(); // Time to first token
         tokensGenerated++;
         const elapsedSeconds = (Date.now() - messageBeganAt) / 1000;
         toksPerSec = tokensGenerated / elapsedSeconds;

         responseText += chunk.data;
         process.stdout.write(chunk.data);

         // Fire async function without blocking the generator
         const now = Date.now();
         if ((now - lastMsgUpdate) / 1000 >= 2) {
            lastMsgUpdate = now;
            updateMsg().catch((err) =>
               console.error("Async task failed:", err)
            );
         }
         userLogger.debug(
            JSON.stringify({
               event: "textGenerationFailure",
               ...logging,
               failureReason: "arena moderation block"
            })
         );
      } else {
         console.log("Unknown event:", chunk);
      }
   }
   console.log("\n-------------------------------");
   const totalElapsedSeconds = (Date.now() - messageBeganAt) / 1000;
   const averageCps = tokensGenerated / totalElapsedSeconds;
   const container = new ContainerBuilder();
   container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${trimString(userPrompt)}`)
   );
   let filesToAttach = [];
   if (hasVision) {
      // reupload
      const inputImageContents = Buffer.from(
         await (await fetch(visionAttachment.url)).arrayBuffer()
      );
      const vfn =
         "vision-" +
         randomBytes(4).toString("hex") +
         "." +
         mimeToExt(visionAttachment.contentType || "image/png");
      const visionAttachment2 = new AttachmentBuilder(inputImageContents, {
         name: vfn
      });
      filesToAttach.push(visionAttachment2);
      container.addMediaGalleryComponents(
         new MediaGalleryBuilder().addItems((item) =>
            item.setURL(`attachment://${vfn}`)
         )
      );
   }
   container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(1)
   );

   if (responseText.length >= 2000) {
      const file = new AttachmentBuilder(Buffer.from(responseText, "utf-8"), {
         name: "response.txt",
         description: "Full response text"
      });
      filesToAttach.push(file);
      container.addFileComponents(
         new FileBuilder().setURL("attachment://response.txt")
      );
   } else {
      container.addTextDisplayComponents(
         new TextDisplayBuilder().setContent(responseText)
      );
   }
   container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(1)
   );
   container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
         `-# ${tokensGenerated} tokens, ${averageCps.toFixed(1)} tokens per second, ${totalElapsedSeconds.toFixed(2)} seconds elapsed`
      )
   );
   container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# Model used: ${modelUsed}\n-# Support ID: ${logging.supportId} (use this when making a support post)`)
   );

   userLogger.info(
      `(SupportId:${logging.supportId}) User ${logging.username} (${logging.userId}) completed text generation in guild ${logging.guild} using model ${modelUsed}, generating ${tokensGenerated} tokens in ${totalElapsedSeconds.toFixed(2)} seconds (${averageCps.toFixed(2)} tok/sec).`
   );
   userLogger.debug(
      JSON.stringify({
         event: "textGenerationComplete",
         ...logging,
         responseText,
         tokensGenerated,
         totalElapsedSeconds,
         averageCps
      })
   );

   await editReply({
      content: null,
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      files: filesToAttach
   });
}

async function generateImage(interaction, ahh) {
   const { chat, message, vision, logging } = ahh;
   const { hasVision, visionBuffer, visionAttachment } = vision;
   let attachmentsToSend = [];
   let optionalContent = ""; // Only used for API errors, image modality doesn't send text chunks
   const startTime = Date.now();
   for await (const chunk of chat.sendMessage(message)) {
      console.log(chunk);
      // a0/c0 are only fired for an error, they are never sent normally
      if (chunk.event === "a0") {
         optionalContent += chunk.data;
      } else if (chunk.event === "c0") {
         optionalContent += chunk.data;
         userLogger.debug(
            JSON.stringify({
               event: "imageGenerationFailure",
               ...logging,
               failureReason: "arena moderation block"
            })
         );
      } else if (chunk.event === "a3") {
         optionalContent += "An unknown error occurred.";
         userLogger.debug(
            JSON.stringify({
               event: "imageGenerationFailure",
               ...logging,
               failureReason: "provider-based error"
            })
         );
      } else if (chunk.event === "a2") {
         for (const obj of chunk.data) {
            if (obj.type === "image") {
               const fileContents = await (
                  await fetch(obj.image)
               ).arrayBuffer();
               const fileName =
                  "image-" +
                  randomBytes(4).toString("hex") +
                  "." +
                  mimeToExt(obj.mimeType || "image/png");
               attachmentsToSend.push({
                  mime: obj.mimeType,
                  url: obj.image,
                  // Used to build Attachment
                  dFileName: fileName,
                  dFileContents: fileContents
               });
            }
         }
      } else if (chunk.event === "ad") {
         if (chunk.data === "retry") {
            await generateImage(interaction, ahh);
            return;
         }
         break;
      }
   }
   const durationSeconds = (Date.now() - startTime) / 1000;
   const container = new ContainerBuilder();
   container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${message.content}`)
   );
   if (visionBuffer !== null) {
      container.addMediaGalleryComponents(
         new MediaGalleryBuilder().addItems((item) =>
            item.setURL(visionAttachment.url)
         )
      );
   }
   container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(1)
   );
   if (optionalContent.length > 0) {
      container.addTextDisplayComponents(
         new TextDisplayBuilder().setContent(`${optionalContent}`)
      );
   }
   let filesToAttach = [];
   const items = attachmentsToSend.map((att) => {
      const buf = Buffer.from(att.dFileContents);
      const f = new AttachmentBuilder(buf, {
         name: att.dFileName
      });
      filesToAttach.push(f);
      return new MediaGalleryItemBuilder().setURL(
         `attachment://${att.dFileName}`
      );
   });
   if (items.length > 0) {
      container.addMediaGalleryComponents(
         new MediaGalleryBuilder().addItems(...items)
      );
   }
   container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(1)
   );
   container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
         `-# Model used: ${logging.model}, took ${durationSeconds.toFixed(2)} seconds\n-# Support ID: ${logging.supportId} (use this when making a support post)`
      )
   );

   userLogger.info(
      `(SupportId:${logging.supportId}) User ${logging.username} (${logging.userId}) completed image generation in guild ${logging.guild} using model ${logging.model}, generating ${items.length} images.`
   );
   userLogger.debug(
      JSON.stringify({
         event: "imageGenerationComplete",
         ...logging,
         numImages: items.length
      })
   );

   await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      files: filesToAttach
   });
}

/**
 *
 * @param {ButtonInteraction} bInteraction
 * @param {string} umid
 * @returns
 */
export async function retryMessage(bInteraction, umid) {
   const data = userMessagesMap.get(umid);
   if (!data) {
      await bInteraction.reply({
         content: "message not found",
         flags: MessageFlags.Ephemeral
      });
      return;
   }

   await data.interaction.deleteReply();

   await bInteraction.deferReply();

   data.interaction = bInteraction;
   userMessagesMap.set(umid, data); // make sure it propagated

   // We recreated a new reply, now rerun generation.
   await performInferenceTextMode(umid, true);
}

function diffStrings(a, b) {
   const normalize = (s) =>
      s
         .replace(/\r\n/g, "\n")
         .split("\n")
         .map((l) => l.trimEnd());
   const aLines = normalize(a);
   const bLines = normalize(b);

   const m = aLines.length;
   const n = bLines.length;

   // LCS matrix
   const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
   for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
         if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
         else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
   }

   // Backtrack to build diff
   const diff = [];
   let i = 0,
      j = 0;
   while (i < m && j < n) {
      if (aLines[i] === bLines[j]) {
         diff.push(" " + aLines[i]);
         i++;
         j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
         diff.push("- " + aLines[i]);
         i++;
      } else {
         diff.push("+ " + bLines[j]);
         j++;
      }
   }
   while (i < m) diff.push("- " + aLines[i++]);
   while (j < n) diff.push("+ " + bLines[j++]);

   return diff.join("\n");
}

/**
 *
 * @param {string} filePath
 * @param {any} encoding
 * @returns
 */
function safeReadFile(filePath, encoding = "utf-8") {
   try {
      return readFileSync(filePath, encoding);
   } catch (err) {
      if (err.code === "ENOENT") return null; // file not found
      throw err; // rethrow other errors
   }
}

const AnonModelPath = path.join(
   import.meta.dirname,
   "../../lib/anon-models.txt"
);

/**
 *
 * @param {ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
   const subCommand = interaction.options.getSubcommand(true);
   const username = interaction.user.username;
   const id = interaction.user.id;
   const guildId = interaction.guildId ?? 0;
   const runningFromGuildName = (interaction.guild ?? { name: "DMs" }).name;
   if (guildId === "1434990244675063828" && !superusers.includes(id) && interaction.channelId !== "1435008484109193318") {
      await interaction.reply({
         content:
            "Please go to <#1435008484109193318> to use commands.",
         flags: MessageFlags.Ephemeral
      });
      return;
   }
   switch (subCommand) {
      case "fetch-log": {
         if (!superusers.includes(interaction.user.id)) {
            await interaction.reply({
               content: "Must be a superuser to use this command.",
               flags: MessageFlags.Ephemeral
            });
            break;
         }
         const supportId = interaction.options.getString("support-id", true);
         const logs = await getLogsForSupportId({
            logDir: path.resolve(import.meta.dirname, "../../logs"),
            supportId,
            category: "command-usage"
         });
         if (logs.length === 0) {
            await interaction.reply(
               `No logs found for support ID ${supportId}.`
            );
            return;
         }
         const container = new ContainerBuilder();
         container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# Logs for support ID ${supportId}`)
         );
         container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(1)
         );
         const file = new AttachmentBuilder(
            Buffer.from(JSON.stringify(logs), "utf-8"),
            {
               name: `logs-${supportId}.txt`,
               description: `Logs for support ID ${supportId}`
            }
         );
         container.addFileComponents(
            new FileBuilder().setURL(`attachment://logs-${supportId}.txt`)
         );
         await interaction.reply({
            components: [container],
            files: [file],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
         });
         break;
      }
      case "anon-models": {
         const anonModels = [];
         const lastCache = safeReadFile(AnonModelPath, "utf-8");

         for (let [key, value] of lmArena.models.entries()) {
            if (!value.organization || !value.provider) {
               anonModels.push(value.publicName);
            }
         }
         const builtStr = anonModels.join("\n");
         const diff = diffStrings(lastCache ?? "", builtStr);
         writeFileSync(AnonModelPath, builtStr, "utf-8");

         await interaction.reply(
            anonModels.length > 0
               ? `Anonymous Models:\n\`\`\`diff\n${diff}\n\`\`\``
               : "No anonymous models found."
         );

         userLogger.info(
            `User ${username} (${id}) listed anonymous models in guild ${runningFromGuildName}`
         );
         break;
      }
      case "model-info": {
         const model = interaction.options.getString("model", true);
         if (!lmArena.models.has(model)) {
            await interaction.reply("Model not found.");
            return;
         }
         const modelData = lmArena.models.get(model);
         const container = new ContainerBuilder();
         container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# ${model}`)
         );
         container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(1)
         );
         container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
               `Organization: ${modelData.organization || "Unknown"}\nProvider: ${modelData.provider || "Unknown"}`
            )
         );
         container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(1)
         );
         let inputCapStr = "Input Capabilities:\n";
         let outputCapStr = "Output Capabilities:\n";
         if (modelData.capabilities.inputCapabilities.text) {
            inputCapStr += "* Text\n";
         }
         if (modelData.capabilities.inputCapabilities.image) {
            inputCapStr += "* Image\n";
         }
         if (modelData.capabilities.outputCapabilities.text) {
            outputCapStr += "* Text\n";
         }
         if (modelData.capabilities.outputCapabilities.image) {
            outputCapStr += "* Image\n";
         }
         if (modelData.capabilities.outputCapabilities.video) {
            outputCapStr += "* Video\n";
         }
         if (modelData.capabilities.outputCapabilities.search) {
            outputCapStr += "* Grounding (search)\n";
         }
         container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(inputCapStr)
         );
         container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(outputCapStr)
         );
         await interaction.reply({
            components: [container],
            flags: MessageFlags.IsComponentsV2
         });
         userLogger.info(
            `User ${username} (${id}) queried model info for ${model} in guild ${runningFromGuildName}`
         );
         break;
      }
      case "refresh-models": {
         await interaction.deferReply({ flags: MessageFlags.Ephemeral });
         // Refresh the models list and give the user a diff
         const oldModels = new Set(lmArena.models.keys());
         await lmArena.refetchModels();
         const newModels = new Set(lmArena.models.keys());
         const added = [];
         const removed = [];
         for (let m of newModels) {
            if (!oldModels.has(m)) {
               added.push(m);
            }
         }
         for (let m of oldModels) {
            if (!newModels.has(m)) {
               removed.push(m);
            }
         }
         let reply = "";
         if (added.length > 0) {
            reply += `Added: ${added.join(", ")}`;
         }

         if (removed.length > 0) {
            if (reply.length > 0) reply += "\n";
            reply += `Removed: ${removed.join(", ")}`;
         }
         if (reply.length === 0) {
            reply = "No changes.";
         }
         await interaction.editReply(reply);
         userLogger.info(
            `User ${username} (${id}) refreshed models list in guild ${runningFromGuildName}`
         );
         break;
      }
      case "r2": {
         const attachment = interaction.options.getAttachment("file", true);
         await interaction.deferReply({ flags: MessageFlags.Ephemeral });
         const fResponse = await fetch(attachment.proxyURL);
         const buffer = Buffer.from(await fResponse.arrayBuffer());
         const fileType = await fileTypeFromBuffer(buffer);

         const response = await lmArena.sessionManager.uploadAttachmentToR2(
            {
               doesSessionExist: false
            },
            {
               mime: fileType ? fileType.mime : attachment.contentType,
               content: buffer
            }
         );

         if (response && response.url && response.url.length > 0) {
            await interaction.editReply(`${response.url}`);
         } else {
            await interaction.editReply({
               content: `Upload failed, no URL returned. Full response:\n\`\`\`json\n${JSON.stringify(
                  response,
                  null,
                  2
               )}\n\`\`\``
            });
         }
         userLogger.info(
            `User ${username} (${id}) uploaded a file to R2 in guild ${runningFromGuildName}`
         );
         break;
      }
      case "reset-token": {
         if (!superusers.includes(interaction.user.id)) {
            await interaction.reply({
               content: "Must be a superuser to use this command.",
               flags: MessageFlags.Ephemeral
            });
            return;
         }

         await interaction.deferReply({
            flags: MessageFlags.Ephemeral
         });

         const [success, clearanceToken, possibleErrorBody] =
            await lmArena.updateArenaAuth();

         if (!success) {
            const file = new AttachmentBuilder(
               Buffer.from(possibleErrorBody, "utf-8"),
               {
                  name: "debug.txt",
                  description: "Returned response for debugging."
               }
            );
            await interaction.editReply({
               content: "Failed to fetch new token, response attached.",
               files: [file]
            });
            return;
         }

         await interaction.editReply(
            `Successfully refreshed arena token, CF clearance used:\n\`\`\`\n${clearanceToken}\n\`\`\``
         );

         break;
      }
      case "text-gen": {
         await interaction.deferReply();
         const supportId = generateSupportId();
         const model = interaction.options.getString("model", true);
         const prompt = interaction.options.getString("prompt", true);
         const system = interaction.options.getString("system");
         const vision = interaction.options.getAttachment("vision");
         let visionBuffer = null;
         if (vision) {
            let modelData = lmArena.models.get(model);
            if (!modelData.capabilities.inputCapabilities.image) {
               await interaction.reply(
                  "This model does not support image inputs."
               );
               return;
            }
            const response = await fetch(vision.proxyURL);
            visionBuffer = Buffer.from(await response.arrayBuffer());
         }

         const chat = lmArena.startChat(model, "chat");
         if (system) {
            await chat.addMessage({
               role: "system",
               content: system,
               attachments: []
            });
         }
         const message = {
            role: "user",
            content: prompt,
            attachments: []
         };
         if (visionBuffer !== null) {
            message.attachments.push({
               mime: vision.contentType,
               content: visionBuffer,
               r2BucketUrl: null
            });
         }

         const msg = await interaction.editReply(
            "`0 tokens | 0 tok/sec | 0s elapsed`"
         );

         userMessagesMap.set(interaction.id, {
            message: message,
            interaction,
            lmChat: chat,
            meta: {
               userPrompt: prompt,
               modelUsed: model,
               visionAttachment: vision || undefined,
               hasVision: !!visionBuffer
            },
            logging: {
               supportId,
               userId: id,
               username,
               guild: runningFromGuildName,
               model,
               prompt,
               hasVision: !!visionBuffer
            }
         });

         userLogger.info(
            `(SupportId:${supportId}) User ${username} (${id}) started text generation with prompt ${prompt}, model ${model}${!!visionBuffer ? ", and image attachment" : ""} in guild ${runningFromGuildName}.`
         );
         // Machine-readable log
         userLogger.debug(
            JSON.stringify({
               event: "textGenerationStart",
               supportId,
               userId: id,
               username,
               guild: runningFromGuildName,
               model,
               prompt,
               hasVision: !!visionBuffer
            })
         );

         await performInferenceTextMode(interaction.id);
         break;
      }
      case "image-gen": {
         await interaction.deferReply();
         const supportId = generateSupportId();
         const model = interaction.options.getString("model", true);
         const prompt = interaction.options.getString("prompt", true);
         const vision = interaction.options.getAttachment("image");
         let visionBuffer = null;
         if (vision) {
            let modelData = lmArena.models.get(model);
            if (!modelData.capabilities.inputCapabilities.image) {
               await interaction.editReply(
                  "This model does not support image inputs."
               );
               return;
            }
            const response = await fetch(vision.proxyURL);
            visionBuffer = Buffer.from(await response.arrayBuffer());
         }
         const chat = lmArena.startChat(model, "image");
         const message = {
            role: "user",
            content: prompt,
            attachments: []
         };
         if (visionBuffer !== null) {
            message.attachments.push({
               mime: vision.contentType,
               content: visionBuffer,
               r2BucketUrl: null
            });
         }

         userLogger.info(
            `(SupportId:${supportId}) User ${username} (${id}) started image generation with prompt ${prompt}, model ${model}${!!visionBuffer ? ", and image attachment" : ""} in guild ${runningFromGuildName}.`
         );
         userLogger.debug(
            JSON.stringify({
               event: "imageGenerationStart",
               supportId,
               userId: id,
               username,
               guild: runningFromGuildName,
               model,
               prompt,
               hasVision: !!visionBuffer
            })
         );

         await generateImage(interaction, {
            chat,
            message,
            vision: {
               hasVision: !!visionBuffer,
               visionBuffer,
               visionAttachment: vision || undefined
            },
            logging: {
               supportId,
               userId: id,
               username,
               guild: runningFromGuildName,
               model,
               prompt,
               hasVision: !!visionBuffer
            }
         });
         break;
      }
      case "filter-models": {
         const inputModality = interaction.options.getString("input-modality");
         const outputModality = interaction.options.getString("output-modality");
         if (!inputModality && !outputModality) {
            await interaction.reply(
               "You must provide at least one of inputModality or outputModality."
            );
            return;
         }
         const inputMods = inputModality
            ? inputModality.split(",").map((s) => s.trim().toLowerCase())
            : [];
         const outputMods = outputModality ? outputModality.split(",").map((s) => s.trim().toLowerCase()) : [];
         const matchingModels = [];
         // lmArena.models is a Map<string, Model>
         for (let [key, value] of lmArena.models.entries()) {
            let inputMatch = true;
            let outputMatch = true;
            for (let im of inputMods) {
               if (im === "text" && !value.capabilities.inputCapabilities.text) {
                  inputMatch = false;
               } else if (im === "image" && !value.capabilities.inputCapabilities.image) {
                  inputMatch = false;
               }
            }
            for (let om of outputMods) {
               if (om === "text" && !value.capabilities.outputCapabilities.text) {
                  outputMatch = false;
               } else if (om === "image" && !value.capabilities.outputCapabilities.image) {
                  outputMatch = false;
               } else if (om === "video" && !value.capabilities.outputCapabilities.video) {
                  outputMatch = false;
               } else if (om === "search" && !value.capabilities.outputCapabilities.search) {
                  outputMatch = false;
               }
            }
            if (inputMatch && outputMatch) {
               matchingModels.push(key);
            }
         }

         if (matchingModels.length === 0) {
            await interaction.reply("No models found matching the criteria.");
            return;
         }
         await interaction.reply(
            `Matching models:\n\`\`\`\n${matchingModels.join("\n")}\n\`\`\``
         );
         break;
      }
      default:
         break;
   }
}

/**
 * Fast fuzzy search that scores matches based on:
 * - Consecutive character matches (higher score)
 * - Earlier matches (higher score)
 * - Case-sensitive matches (bonus)
 */
function fuzzySearch(needle, haystack, limit = 25) {
   if (!needle) return haystack.slice(0, limit);

   const lowerNeedle = needle.toLowerCase();
   const scored = [];

   for (const item of haystack) {
      const lowerItem = item.toLowerCase();
      let score = 0;
      let needleIdx = 0;
      let consecutive = 0;

      for (
         let i = 0;
         i < lowerItem.length && needleIdx < lowerNeedle.length;
         i++
      ) {
         if (lowerItem[i] === lowerNeedle[needleIdx]) {
            // Position bonus (earlier matches score higher)
            score += 100 - i;

            // Consecutive match bonus
            consecutive++;
            score += consecutive * 10;

            // Exact case match bonus
            if (item[i] === needle[needleIdx]) score += 5;

            needleIdx++;
         } else {
            consecutive = 0;
         }
      }

      // Only include if all characters were matched
      if (needleIdx === lowerNeedle.length) {
         scored.push({ item, score });
      }
   }

   // Sort by score descending and return items
   return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.item);
}

export async function autocomplete(interaction) {
   const subCommand = interaction.options.getSubcommand(true);
   const focused = interaction.options.getFocused(true);

   if (focused.name !== "model") {
      await interaction.respond([]);
      return;
   }

   let realChoices = [];
   if (subCommand === "text-gen") {
      for (let [key, value] of lmArena.models.entries()) {
         if (value.capabilities.outputCapabilities.text) {
            realChoices.push(key);
         }
      }
   } else if (subCommand === "image-gen") {
      for (let [key, value] of lmArena.models.entries()) {
         if (value.capabilities.outputCapabilities.image) {
            realChoices.push(key);
         }
      }
   } else if (subCommand === "model-info") {
      realChoices = Array.from(lmArena.models.keys());
   }

   const filtered = fuzzySearch(focused.value, realChoices, 25);

   await interaction.respond(
      filtered.map((choice) => ({ name: choice, value: choice }))
   );
}
