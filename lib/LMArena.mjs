// Orchestrator

import { Browser } from "./Browser.mjs";
import { randomUUID } from "node:crypto";
import { parseAndDereference } from "./util.mjs";
import { SessionManager } from "./SessionManager.mjs";
import { writeFileSync } from "node:fs";
import { Logger } from "./OPLogger.mjs";

// ... (helper functions and Chat class remain the same) ...
function serializeToCookie(obj) {
   return Object.entries(obj)
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
}

export const LM_NEXT_ACTIONS = {
   ATTACHMENT_URL_INIT: "7020a654f560cf3773ea19b2053412b2b9b132a309",
   ATTACHMENT_FETCH_URL: "600bd3b6949d926e5f713005e3ff26d6cfc125944e"
};

/**
 * @typedef {Object} Cookie
 * @property {string} name
 * @property {string} value
 * @property {string} domain
 * @property {string} path
 * @property {number} expires
 * @property {boolean} httpOnly
 * @property {boolean} secure
 * @property {boolean} session
 * @property {number} size
 */

class CookieHelper {
   /**
    * 
    * @param {import("puppeteer-real-browser").PageWithCursor} page 
    */
   constructor(page) {
     this.page = page;
   }
 
   /**
    * Fetch cookie by name
    * @param {string} name Cookie name to fetch
    * @returns { Promise<Cookie> } the cookie
    */
   async getCookieByName(name) {
     const cookies = await this.page.browserContext().cookies();
     return cookies.find(c => c.name === name) || null;
   }
 
   /**
    * delete cookie
    * @param {string} name 
    * @returns {Promise<boolean>} true if deleted, false if not found
    */
   async deleteCookieByName(name) {
     const cookie = await this.getCookieByName(name);
     if (!cookie) return false; // cookie not found
 
     await this.page.browserContext().deleteCookie(cookie);
     return true;
   }
 }

export const LM_EVENT_NAMES = new Map(
   Object.entries({
      0: "text",
      2: "data",
      3: "error",
      4: "assistant_message",
      5: "assistant_control_data",
      6: "data_message",
      8: "message_annotations",
      9: "tool_call",
      a: "tool_result",
      b: "tool_call_streaming_start",
      c: "tool_call_delta",
      d: "finish_message",
      e: "finish_step",
      f: "start_step",
      g: "reasoning",
      h: "source",
      i: "redacted_reasoning",
      j: "reasoning_signature",
      k: "file"
   })
);

export class Chat {
   constructor(sessionManager, session) {
      this.sessionManager = sessionManager;
      this.session = session;
   }

   async *sendMessage(message, retry = false) {
      await this.sessionManager.sendMessage(this.session, message);
      //yield* this.sessionManager.runInference(this.session, null, retry);
      // updated
      yield* this.sessionManager.runInferenceV2(this.session, null, retry);
   }

   shuffleSession() {
      this.session.sessionId = crypto.randomUUID();
      this.session.lmSession.id = this.session.sessionId;
      this.session.doesSessionExist = false;
   }

   // Process tokens and yield openai-compatible response chunks
   async sendMessageOAICompat(message = null, messagesOverride = null) {
      return "please don't use this";
   }

   async addMessage(message) {
      await this.sessionManager.sendMessage(this.session, message);
   }

   getMessageHistory() {
      return this.session.messages;
   }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LMArena {
   constructor() {
      
      this.sessionManager = new SessionManager(this);
      this.models = null;
      this.actionCache = new Map();
      this.scriptCache = new Map();
      this.logger = new Logger("lmarena");
      this.browser = new Browser(this.logger);
      this.fetchLogger = this.logger.makeChild("fetchProxy");
   }
   async init() {
      await this.browser.init();
      await this.browser.updateCookies();
      const models = await this.browser.getModels();
      this.models = new Map();
      for (const model of models) {
         // Use the ID as the key for easier lookup
         this.models.set(model.publicName, model);
      }
   }
   async refetchModels() {
      await this.browser.page.reload({
         waitUntil: "domcontentloaded"
      });
      let models;
      while (true) {
         models = await this.browser.getModels();
         if (models.length > 0) break;
         await sleep(1000);
         this.logger.info("retrying fetch models");
         this.logger.debug(models);
      }
      this.models = new Map();
      for (const model of models) {
         // Use the ID as the key for easier lookup
         this.models.set(model.publicName, model);
      }
      return models;
   }

   /**
    * Makes an authenticated HTTP request.
    *
    * @param {Object} params - The request parameters.
    * @param {string} params.url - The URL to send the request to.
    * @param {"GET"|"POST"|"PUT"|"DELETE"|"PATCH"} [params.method="GET"] - The HTTP method.
    * @param {Object<string, string>} [params.headers={}] - Optional headers to include in the request.
    * @param {any} [params.body] - Optional request body (JSON, string, etc.).
    * @returns {Promise<Response>} The fetch response.
    */
   async makeAuthedRequest({ url, method = "GET", headers = {}, body }) {
      const page = this.browser.page;
      const reqId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      return new Promise(async (resolve, reject) => {
         let controllerRef;

         // Create a ReadableStream for chunks
         const stream = new ReadableStream({
            start(controller) {
               controllerRef = controller;
            },
            cancel() {
               this.fetchLogger.debug(`[${reqId}] Stream cancelled`);
               delete page._streamHandlers?.[reqId];
            }
         });

         if (!page._streamHandlers) page._streamHandlers = {};

         // Node-side handler with logging
         page._streamHandlers[reqId] = (msg) => {
            this.fetchLogger.debug(`[${reqId}] Received message:`, msg);

            if (msg.type === "meta") {
               this.fetchLogger.debug(`[${reqId}] Meta received, resolving Response`);
               resolve(
                  new Response(stream, {
                     status: msg.status,
                     statusText: msg.statusText,
                     headers: msg.headers
                  })
               );
            } else if (msg.type === "chunk") {
               this.fetchLogger.debug(`[${reqId}] Chunk length: ${msg.data.length}`);
               controllerRef.enqueue(new TextEncoder().encode(msg.data));
            } else if (msg.type === "end") {
               this.fetchLogger.debug(`[${reqId}] End of stream`);
               controllerRef.close();
               delete page._streamHandlers[reqId];
            } else if (msg.type === "error") {
               console.error(`[${reqId}] Error from browser: ${msg.error}`);
               controllerRef.error(new Error(msg.error));
               delete page._streamHandlers[reqId];
            }
         };

         // Synchronized exposure of nodeStreamBridge (handles race conditions)
         if (!page._bridgeExposed) {
            if (!page._exposingBridge) {
               page._exposingBridge = page
                  .exposeFunction("nodeStreamBridge", (reqId, payload) => {
                     const handler = page._streamHandlers?.[reqId];
                     if (handler) handler(payload);
                     else
                        console.warn(
                           `[${reqId}] No handler found for payload`,
                           payload
                        );
                  })
                  .then(() => {
                     this.fetchLogger.debug(`Exposed nodeStreamBridge`);
                  })
                  .catch((err) => {
                     // Benign if already exposed (Puppeteer throws something like "Function already exists")
                     if (
                        err.message &&
                        err.message.includes("nodeStreamBridge") &&
                        err.message.includes("already")
                     ) {
                        this.fetchLogger.debug(
                           `nodeStreamBridge already exposed (race resolved)`
                        );
                     } else {
                        console.error(
                           `Failed to expose nodeStreamBridge:`,
                           err
                        );
                        throw err; // Re-throw non-benign errors
                     }
                  })
                  .finally(() => {
                     page._bridgeExposed = true;
                     page._exposingBridge = null;
                  });
            }
            // Await completion if another call started it
            await page._exposingBridge;
         }

         this.fetchLogger.debug(`[${reqId}] Starting fetch in browser...`);

         // Run fetch inside the browser
         await page.evaluate(
            async ({ url, method, headers, body, reqId }) => {
               try {
                  const response = await fetch(url, {
                     method,
                     headers,
                     body,
                     credentials: "include"
                  });

                  await window.nodeStreamBridge(reqId, {
                     type: "meta",
                     ok: response.ok,
                     status: response.status,
                     statusText: response.statusText,
                     headers: Object.fromEntries(response.headers.entries())
                  });

                  const reader = response.body.getReader();
                  const decoder = new TextDecoder();

                  while (true) {
                     const { done, value } = await reader.read();
                     if (done) break;
                     await window.nodeStreamBridge(reqId, {
                        type: "chunk",
                        data: decoder.decode(value, { stream: true })
                     });
                  }

                  await window.nodeStreamBridge(reqId, { type: "end" });
               } catch (err) {
                  await window.nodeStreamBridge(reqId, {
                     type: "error",
                     error: String(err)
                  });
               }
            },
            { url, method, headers, body, reqId }
         );
      });
   }

   async updateArenaAuth() {
      const ch = new CookieHelper(this.browser.page);
      await ch.deleteCookieByName("arena-auth-prod-v1");
      await ch.deleteCookieByName("provisional_user_id");
      this.logger.debug("deleted cookies");
      const provResponse = await this.makeAuthedRequest({
         url: "https://lmarena.ai/",
         method: "GET"
      });
      const prt = await provResponse.text();
      const cookie = await ch.getCookieByName("provisional_user_id");
      console.log(cookie)
      if (!cookie) {
         this.logger.error("failed to get provisional userid");
         return [false, null, prt];
      }
      const provisional_user_id = cookie.value;
      console.log(provisional_user_id);
      this.logger.info("getting token");
      const clearance = await this.browser.getCfToken();
      const response = await this.makeAuthedRequest({
         url: "https://lmarena.ai/nextjs-api/sign-up",
         method: "POST",
         headers: {
            "Content-Type": "text/plain;charset=UTF-8"
         },
         body: JSON.stringify({
            turnstileToken: clearance,
            provisionalUserId: provisional_user_id
         })
      });
      if (response.ok) {
         this.logger.info("updated user");
         return [true, clearance, ""];
      }
      this.logger.error("failed to update user");
      const rt = await response.text();
      this.logger.debug(rt);
      return [false, clearance, rt];
   }

   async attemptFetchAction(actionDbgKey) {
      const loadedExternals = await this.browser.page.evaluate(() => {
         return window.performance
            .getEntriesByType("resource")
            .filter((entry) => entry.initiatorType === "script")
            .map((entry) => entry.name);
      });
      // Get all URLs starting with https://lmarena.ai/_next/static/chunks/
      const staticChunkUrls = loadedExternals.filter((url) =>
         url.startsWith("https://lmarena.ai/_next/static/chunks/")
      );
      const results = [];
      const regex = new RegExp(
         `\\(0,[A-Za-z0-9]*\\.createServerReference\\)\\("([0-9a-f]+)",[A-Za-z0-9]*\\.callServer,void 0,[A-Za-z0-9]*\\.findSourceMapURL,"${actionDbgKey}"\\)`,
         "g"
      );
      for (const url of staticChunkUrls) {
         let text = "NOSCRIPT";
         if (this.scriptCache.has(url)) {
            text = this.scriptCache.get(url);
         } else {
            const response = await this.makeAuthedRequest({
               url,
               method: "GET"
            });
            text = await response.text();

            this.scriptCache.set(url, text);
         }
         const matches = [...text.matchAll(regex)];

         if (matches.length > 0) {
            // RegExpExecArray
            const root = matches[0];
            // Full match is root[0], first capture group is root[1]
            if (root[1]) {
               results.push(root[1]);
            }
         }
      }
      return results;
   }

   async action(key) {
      if (this.actionCache.has(key)) {
         return this.actionCache.get(key);
      }
      const KEY_DK_MAP = {
         ATTACHMENT_URL_INIT: "generateUploadUrl",
         ATTACHMENT_FETCH_URL: "getSignedUrl"
      };
      const dk = KEY_DK_MAP[key];
      if (!dk) throw new Error(`Invalid action key: ${key}`);
      const actionResult = await this.attemptFetchAction(dk);
      if (actionResult.length > 0) {
         this.logger.debug(actionResult);
         this.actionCache.set(key, actionResult[0]);
         return actionResult[0];
      }
      throw new Error(`Failed to locat e action for key: ${key}`);
   }

   startChat(modelId, chatModality) {
      // --- CRITICAL FIX ---
      // Look up the full model object from the map using the ID.
      const model = this.models.get(modelId);
      if (!model) {
         throw new Error(`Model with name "${modelId}" not found.`);
      }
      // Pass the full model object to createSession.
      const session = this.sessionManager.createSession(model, chatModality);
      return new Chat(this.sessionManager, session);
   }
}
