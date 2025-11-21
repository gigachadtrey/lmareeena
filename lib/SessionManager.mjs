/// SessionManager.mjs
// Manages chats and chat history

// LEGACY: API requires UUID version 7, randomUUID only generates version 4
//import { randomUUID } from "node:crypto";
import { v7 as randomUUID } from "uuid";
import fs from "node:fs";
import { TransformStream } from "node:stream/web";
import { Readable } from "node:stream";
import { parseAndDereference } from "./util.mjs";
import { LM_NEXT_ACTIONS, LMArena } from "./LMArena.mjs";

/**
 * Import all exported types from the main declaration file into the "Types" namespace.
 * @typedef {import('types/lmarena').Attachment} Attachment
 * @typedef {import('types/lmarena').LargeAttachment} LargeAttachment
 */

export class SessionManager {
   /**
    *
    * @param {LMArena} lmarenaObject
    */
   constructor(lmarenaObject) {
      /**
       * @type {LMArena}
       */
      this.lmarena = lmarenaObject;
   }

   /**
    *
    * @param {string} modelId
    * @param {string} chatModality
    * @returns {Types.ChatSession}
    */
   createSession(model, chatModality) {
      const sessionId = randomUUID();
      return {
         // This is the object that will be sent to the API
         lmSession: {
            id: sessionId,
            messages: [],
            modality: chatModality,
            mode: "direct",
            modelAId: model.id, // FIX: Use only the model's ID string
            modelAMessageId: "",
            userMessageId: ""
         },
         // Internal state for the manager
         doesSessionExist: false,
         sessionId: sessionId, // Ensure internal sessionId matches lmSession id
         messages: []
      };
   }

   // LMArena's new backend is a pain in the ass to work
   // I hate it so much
   createSessionV2(model, chatModality) {
      const sessionId = randomUUID();
      return {
         lmSession: {
            modality: chatModality,
            mode: "direct",
            id: sessionId,
            modelAId: model.id,
            modelAMessageId: "",
            userMessageId: ""
         },
         doesSessionExist: false,
         sessionId,
         messages: [] // This no longer gets updated since the backend maintains conversation a-la OpenAI Responses
      }
   }

   /**
    * Uploads an attachment to R2, supporting both in-memory buffers and large file streams.
    * @param {object} session - The active session object.
    * @param {Attachment | LargeAttachment} attachment - The attachment object.
    * @param {boolean} [stream=false] - If true, streams from `filePath`. If false, uses `content` buffer.
    * @param {(progress: { percentage: number, bytesUploaded: number, totalSize: number }) => void} [onProgress] - Optional callback for stream progress.
    * @returns {Promise<{ url: string, key: string }>} The final, accessible URL of the uploaded file.
    */
   async uploadAttachmentToR2(
      session,
      attachment,
      stream = false,
      onProgress = () => {}
   ) {
      if (!attachment || !attachment.mime) {
         throw new Error("Attachment object must include a 'mime' type.");
      }

      const attStatUrl = session.doesSessionExist
         ? `https://lmarena.ai/c/${session.sessionId}?chat-modality=image`
         : "https://lmarena.ai/?mode=direct&chat-modality=image";

      // --- Step 1: Get the pre-signed upload URL from LMArena (common for both methods) ---
      const getUploadUrlResponse = await this.lmarena.makeAuthedRequest({
         url: attStatUrl,
         method: "POST",
         body: JSON.stringify([
            `image-${randomUUID()}.${attachment.mime.split("/")[1]}`,
            attachment.mime
         ]),
         headers: {
            "content-type": "text/plain;charset=UTF-8",
            accept: "text/x-component",
            "next-action": await this.lmarena.action("ATTACHMENT_URL_INIT")
         }
      });

      const uploadUrlText = await getUploadUrlResponse.text();
      const parsedUploadData = parseAndDereference(uploadUrlText);
      const uploadData = parsedUploadData ? parsedUploadData.a : null;
      if (!uploadData || !uploadData.success || !uploadData.data) {
         throw new Error(
            "Failed to get upload URL: Invalid response from LMArena."
         );
      }

      const r2UploadUrl = uploadData.data.uploadUrl;
      const r2Key = uploadData.data.key;

      // --- Step 2: Prepare and execute the R2 PUT request based on the 'stream' flag ---
      let r2FetchOptions;

      if (stream) {
         // --- LARGE FILE / STREAMING PATH ---
         if (!attachment.filePath || typeof attachment.size !== "number") {
            throw new Error(
               "For stream uploads, attachment must include 'filePath' and 'size'."
            );
         }

         const totalSize = attachment.size;
         let bytesUploaded = 0;
         const nFileStream = fs.createReadStream(attachment.filePath);
         const fileStream = Readable.toWeb(nFileStream);

         // The body is the raw file stream, piped through our progress tracker
         const progressStream = new TransformStream({
            transform(chunk, controller) {
               bytesUploaded += chunk.length;
               const percentage = Math.round((bytesUploaded / totalSize) * 100);
               onProgress({ percentage, bytesUploaded, totalSize });
               controller.enqueue(chunk);
            }
         });

         r2FetchOptions = {
            method: "PUT",
            headers: {
               "Content-Type": attachment.mime,
               "Content-Length": totalSize.toString()
            },
            body: fileStream.pipeThrough(progressStream)
         };
      } else {
         // --- SMALL FILE / BUFFER PATH (DEFAULT) ---
         if (!(attachment.content instanceof Buffer)) {
            throw new Error(
               "For non-stream uploads, attachment.content must be a Buffer."
            );
         }

         r2FetchOptions = {
            method: "PUT",
            headers: {
               "Content-Type": attachment.mime
            },
            body: attachment.content
         };
      }

      console.log(`Starting R2 upload (${stream ? "streaming" : "buffer"})...`);
      const uploadResult = await fetch(r2UploadUrl, r2FetchOptions);

      if (!uploadResult.ok) {
         const errorText = await uploadResult.text();
         throw new Error(
            `Failed to upload to R2. Status: ${uploadResult.status}. Response: ${errorText}`
         );
      }
      console.log("R2 upload finished successfully.");

      const getFinalUrlResponse = await this.lmarena.makeAuthedRequest({
         url: attStatUrl,
         method: "POST",
         body: JSON.stringify([r2Key]),
         headers: {
            "content-type": "text/plain;charset=UTF-8",
            accept: "text/x-component",
            "next-action": await this.lmarena.action("ATTACHMENT_FETCH_URL")
         }
      });

      const finalUrlText = await getFinalUrlResponse.text();
      const parsedFinalData = parseAndDereference(finalUrlText);
      const finalData = parsedFinalData ? parsedFinalData.a : null;
      if (
         !finalData ||
         !finalData.success ||
         !finalData.data ||
         !finalData.data.url
      ) {
         throw new Error("Failed to get final URL after confirming upload.");
      }

      return {
         url: finalData.data.url,
         key: r2Key
      };
   }

   async convertChatMessageToLMMessage(session, chatMessage) {
      const lmMessage = {
         experimental_attachments: [],
         evaluationSessionId: session.sessionId,
         content: chatMessage.content,
         role: chatMessage.role,
         id: chatMessage.id,
         modelId: null,
         parentMessageIds: [],
         participantPosition: "a",
         status: "pending"
      };
      if (chatMessage.attachments.length > 0) {
         for (const att of chatMessage.attachments) {
            if (att.r2BucketUrl !== null) {
               lmMessage.experimental_attachments.push({
                  contentType: att.mime,
                  name: att.r2Key,
                  url: att.r2BucketUrl
               });
               continue;
            }
            const { url: uploadedUrl, key: fileName } =
               await this.uploadAttachmentToR2(session, att);
            lmMessage.experimental_attachments.push({
               contentType: att.mime,
               name: fileName,
               url: uploadedUrl
            });
         }
      }
      return lmMessage;
   }

   async *runInference(session, messagesOverride = null, retry = false) {
      if (messagesOverride) {
         session.messages = [];
         session.lmSession.messages = [];
         for (const msg of messagesOverride) {
            await this.sendMessage(session, msg);
         }
      }
      let payload = session.lmSession;
      let url;

      if (!session.doesSessionExist) {
         url = "https://lmarena.ai/nextjs-api/stream/create-evaluation";
      } else {
         url = `https://lmarena.ai/nextjs-api/stream/post-to-evaluation/${session.sessionId}`;
      }

      if (retry) {
         const assistantId = session.lmSession.modelAMessageId;
         url = `https://lmarena.ai/nextjs-api/stream/retry-evaluation-session-message/${session.sessionId}/messages/${assistantId}`;
         // Remove the assistants message to parity with official
         for (const msgI in session.lmSession.messages) {
            const msg = session.lmSession.messages[msgI];
            if (msg.id.toLowerCase() == assistantId.toLowerCase()) {
               delete session.lmSession.messages[msgI];
               console.log("Deleted latest assistant message", assistantId);
            }
         }
      }

      const response = await this.lmarena.makeAuthedRequest({
         url: url,
         method: retry ? "PUT" : "POST", // yes the api is this pedantic
         headers: {
            Referer: `https://lmarena.ai/c/${session.sessionId}`
         },
         body: JSON.stringify(payload)
      });

      if (!response.ok) {
         const errorText = await response.text();
         if (response.status === 422) {
            const jBody = JSON.parse(errorText);
            yield {
               event: "c0",
               data: "Error: Prompt violates [LMArena ToS](https://lmarena.ai/terms-of-use)"
            };
            yield { event: "ad", data: "err" };
            return;
         } else if (response.status === 429) {
            if (
               response.headers.has("ratelimit-modality") &&
               response.headers.get("ratelimit-modality") === "image" // removed policy check since they keep changing the rules
            ) {
               // LMArena update: anon sessions can only generate (not 3) 1 image to intice you to make an account
               const couldUpdateAuth = await this.lmarena.updateArenaAuth();
               if (couldUpdateAuth) {
                  yield {
                     event: "a0",
                     data: "Anonymous image ratelimit reached, got new session. Try again."
                  };
                  yield { event: "ad", data: "retry" };
               } else {
                  yield {
                     event: "a0",
                     data: "Anonymous image ratelimit reached, but could not refresh token."
                  };
                  yield { event: "ad", data: "err" };
               }
               return;
            }
         } else {
            if (errorText.startsWith('{"error":')) {
               const jBody = JSON.parse(errorText);
               yield { event: "a0", data: `Error: ${jBody.error}` };
               yield { event: "ad", data: "err" };
               return;
            }
         }
         return;
      }

      if (!session.doesSessionExist) {
         session.doesSessionExist = true;
      }

      const assistantMessageForTurn = payload.messages.find(
         (msg) => msg.id && msg.id === payload.modelAMessageId
      );

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Function to process a single line from the stream
      const processLine = (line) => {
         if (line.length < 4) return null; // A valid line like a0:"" is at least 4 chars

         const eventCode = line.substring(0, 2);
         const firstColonIndex = line.indexOf(":");
         if (firstColonIndex === -1) return null; // Malformed line

         const payloadString = line.substring(firstColonIndex + 1);

         try {
            const data = JSON.parse(payloadString);
            if (eventCode === "a0" && typeof data === "string") {
               assistantMessageForTurn.content += data;
            } else if (eventCode === "a2") {
               // data, parse it further
               for (const item of data) {
                  if (item.type === "image") {
                     // Add the image attachment (image property is the R2 url, mimeType is mime) to assistant message
                     assistantMessageForTurn.experimental_attachments.push({
                        contentType: item.mimeType,
                        name: item.name || "image",
                        url: item.image
                     });
                  }
               }
            } else if (eventCode === "ad") {
               assistantMessageForTurn.status = "success";
            }
            return { event: eventCode, data };
         } catch (e) {
            console.error(
               `Failed to parse payload for event [${eventCode}]:`,
               payloadString
            );
            return null;
         }
      };

      try {
         while (true) {
            const { done, value } = await reader.read();
            if (done) {
               // --- HANDLE LEFTOVERS ---
               // If the stream ends and there's still content in the buffer without a trailing newline, process it.
               if (buffer) {
                  const result = processLine(buffer);
                  if (result) yield result;
               }
               break; // Exit the loop
            }

            buffer += decoder.decode(value, { stream: true });

            // --- PROCESS LINE BY LINE ---
            let boundary = buffer.indexOf("\n");
            while (boundary !== -1) {
               const line = buffer.substring(0, boundary).trim();
               buffer = buffer.substring(boundary + 1);

               if (line) {
                  // Process only non-empty lines
                  const result = processLine(line);
                  if (result) yield result;
               }

               boundary = buffer.indexOf("\n");
            }
         }
      } finally {
         reader.releaseLock();
      }
   }

   async *runInferenceV2(session, messagesOverride = null, retry = false) {
      // 1. Handle Message Overrides (History reconstruction)
      if (messagesOverride) {
         session.messages = [];
         session.lmSession.messages = [];
         for (const msg of messagesOverride) {
            await this.sendMessage(session, msg);
         }
      }
   
      // 2. Determine URL and HTTP Method
      let url;
      if (!session.doesSessionExist) {
         url = "https://lmarena.ai/nextjs-api/stream/create-evaluation";
      } else {
         url = `https://lmarena.ai/nextjs-api/stream/post-to-evaluation/${session.sessionId}`;
      }
   
      // 3. Construct the Payload based on new API spec
      // Find the most recent user message to send in this turn
      const currentUserMsg = session.lmSession.messages.find(
         m => m.id === session.lmSession.userMessageId
      );
   
      // Determine modality (simple check, can be expanded based on attachments)
      const modality = session.lmSession.modality || "chat";
   
      let payload = {
         id: session.sessionId,
         mode: "direct", // Assuming 'direct' is standard for this flow
         modelAId: session.lmSession.modelAId,
         userMessageId: session.lmSession.userMessageId,
         modelAMessageId: session.lmSession.modelAMessageId,
         userMessage: {
            content: currentUserMsg ? currentUserMsg.content : "",
            experimental_attachments: currentUserMsg ? (currentUserMsg.experimental_attachments || []) : []
         },
         modality: modality,
         featureFlags: {
            editImageButtonEnabled: "control"
         }
      };
   
      // 4. Handle Retry Logic
      if (retry) {
         const assistantId = session.lmSession.modelAMessageId;
         url = `https://lmarena.ai/nextjs-api/stream/retry-evaluation-session-message/${session.sessionId}/messages/${assistantId}`;
         
         // For retry, we keep the payload mostly the same but target the retry endpoint.
         // The original code removed the assistant message from local history to parity official state.
         for (const msgI in session.lmSession.messages) {
            const msg = session.lmSession.messages[msgI];
            if (msg.id.toLowerCase() == assistantId.toLowerCase()) {
               delete session.lmSession.messages[msgI];
               console.log("Deleted latest assistant message for retry", assistantId);
            }
         }
      }
   
      // 5. Make Request
      const response = await this.lmarena.makeAuthedRequest({
         url: url,
         method: retry ? "PUT" : "POST",
         headers: {
            "Referer": `https://lmarena.ai/c/${session.sessionId}`,
            "Content-Type": "application/json"
         },
         body: JSON.stringify(payload)
      });
   
      // 6. Error Handling
      if (!response.ok) {
         const errorText = await response.text();
         if (response.status === 422) {
            yield {
               event: "c0",
               data: "Error: Prompt violates [LMArena ToS](https://lmarena.ai/terms-of-use)"
            };
            yield { event: "ad", data: "err" };
            return;
         } else if (response.status === 429) {
            if (
               response.headers.has("ratelimit-modality") &&
               response.headers.get("ratelimit-modality") === "image"
            ) {
               const couldUpdateAuth = await this.lmarena.updateArenaAuth();
               if (couldUpdateAuth) {
                  yield {
                     event: "a0",
                     data: "Anonymous image ratelimit reached, got new session. Try again."
                  };
                  yield { event: "ad", data: "retry" };
               } else {
                  yield {
                     event: "a0",
                     data: "Anonymous image ratelimit reached, but could not refresh token."
                  };
                  yield { event: "ad", data: "err" };
               }
               return;
            }
         } else {
            if (errorText.startsWith('{"error":')) {
               const jBody = JSON.parse(errorText);
               yield { event: "a0", data: `Error: ${jBody.error}` };
               yield { event: "ad", data: "err" };
               return;
            }
         }
         return;
      }
   
      if (!session.doesSessionExist) {
         session.doesSessionExist = true;
      }
   
      // 7. Prepare for Stream Processing
      // We need to find or create the assistant message placeholder in our local session to append chunks to
      let assistantMessageForTurn = session.lmSession.messages.find(
         (msg) => msg.id && msg.id === payload.modelAMessageId
      );
   
      // If it doesn't exist (first chunk), create it structure locally
      if (!assistantMessageForTurn) {
         assistantMessageForTurn = {
            id: payload.modelAMessageId,
            role: "assistant",
            content: "",
            experimental_attachments: [],
            status: "pending"
         };
         session.lmSession.messages.push(assistantMessageForTurn);
      }
   
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
   
      // Function to process a single line from the stream
      const processLine = (line) => {
         if (line.length < 4) return null; 
   
         const eventCode = line.substring(0, 2);
         const firstColonIndex = line.indexOf(":");
         if (firstColonIndex === -1) return null;
   
         const payloadString = line.substring(firstColonIndex + 1);
   
         try {
            const data = JSON.parse(payloadString);
            if (eventCode === "a0" && typeof data === "string") {
               assistantMessageForTurn.content += data;
            } else if (eventCode === "a2") {
               for (const item of data) {
                  if (item.type === "image") {
                     assistantMessageForTurn.experimental_attachments.push({
                        contentType: item.mimeType,
                        name: item.name || "image",
                        url: item.image
                     });
                  }
               }
            } else if (eventCode === "ad") {
               assistantMessageForTurn.status = "success";
            }
            return { event: eventCode, data };
         } catch (e) {
            console.error(
               `Failed to parse payload for event [${eventCode}]:`,
               payloadString
            );
            return null;
         }
      };
   
      try {
         while (true) {
            const { done, value } = await reader.read();
            if (done) {
               if (buffer) {
                  const result = processLine(buffer);
                  if (result) yield result;
               }
               break;
            }
   
            buffer += decoder.decode(value, { stream: true });
   
            let boundary = buffer.indexOf("\n");
            while (boundary !== -1) {
               const line = buffer.substring(0, boundary).trim();
               buffer = buffer.substring(boundary + 1);
   
               if (line) {
                  const result = processLine(line);
                  if (result) yield result;
               }
   
               boundary = buffer.indexOf("\n");
            }
         }
      } finally {
         reader.releaseLock();
      }
   }

   async sendMessage(session, message) {
      if (!message.id) message.id = randomUUID();
      if (!message.attachments) message.attachments = [];

      const lastMessage =
         session.lmSession.messages.length > 0
            ? session.lmSession.messages[session.lmSession.messages.length - 1]
            : null;
      const parentMessageId = lastMessage ? lastMessage.id : undefined;

      const lmMessage = await this.convertChatMessageToLMMessage(
         session,
         message
      );
      if (parentMessageId) {
         lmMessage.parentMessageIds = [parentMessageId];
      } else {
         lmMessage.parentMessageIds = [];
      }
      session.messages.push(message);
      session.lmSession.messages.push(lmMessage);

      if (message.role === "user") {
         const assistantMessageId = randomUUID();
         await this.addFillerAssistantMessage(
            session,
            message.id,
            assistantMessageId
         );

         session.lmSession.userMessageId = message.id;
         session.lmSession.modelAMessageId = assistantMessageId;
      }
   }

   async addFillerAssistantMessage(session, replyingToId, assistantMessageId) {
      const fillerMessage = {
         id: assistantMessageId,
         content: "", // Start with empty content
         evaluationSessionId: session.sessionId,
         role: "assistant",
         modelId: session.lmSession.modelAId,
         parentMessageIds: [replyingToId],
         participantPosition: "a",
         status: "pending",
         experimental_attachments: []
      };
      session.lmSession.messages.push(fillerMessage);
   }
}
