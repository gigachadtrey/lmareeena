// Browser.mjs
// Handles turnstile and all cookies that the APIs need
// Additionally provides APIs to fetch data that can only be extracted from a live browser context

import { connect } from "puppeteer-real-browser";
import { readFileSync, mkdirSync } from "fs";
import path from "path";

const keyContents = readFileSync(
   path.resolve(import.meta.dirname, "key.html"),
   "utf-8"
);
const polyfillContent = readFileSync(
   path.resolve(import.meta.dirname, "cookieStore.polyfill.mjs"),
   "utf-8"
);

mkdirSync(path.resolve(import.meta.dirname, "data"), { recursive: true });

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

export class CookieHelper {
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
      return cookies.find((c) => c.name === name) || null;
   }

   /**
    * delete cookie
    * @param {string} name
    * @returns {Promise<boolean>} true if deleted, false if not found
    */
   async deleteCookieByName(name) {
      const cookie = await this.getCookieByName(name);
      if (!cookie) return false; // cookie not found

      await this.page.deleteCookie(cookie);
      return true;
   }
}

export class Browser {
   constructor(logger) {
      this.browser = null;
      this.page = null;
      this.cookies = {};
      this.scriptCache = new Map();
      this.logger = logger.makeChild("browser");
      this.cookieHelper = null;
      this.headless = false;
   }

   async init() {
      const headless = process.env.LMARENA_HEADLESS !== "false";

      const { browser, page } = await connect({
         headless,
         args: [],
         customConfig: {
            protocolTimeout: 60 * 60 * 1000 // 1 hour
         },
         turnstile: true,
         connectOption: {},
         disableXvfb: true,
         ignoreAllFlags: false
      });
      this.browser = browser;
      this.page = page;
      this.cookieHelper = new CookieHelper(this.page);
      this.headless = headless;

      this.challengePage = await browser.newPage();
      await this.challengePage.setRequestInterception(true);
      this.logger.info("Intercepting requests to inject turnstile solver.");
      this.challengePage.on("request", (request) => {
         // If the request is for the main document of our target domain...
         if (
            request.url() === "https://lmarena.ai/" &&
            request.resourceType() === "document"
         ) {
            // ...respond with your custom HTML.
            request.respond({
               status: 200,
               contentType: "text/html",
               body: keyContents
            });
         } else {
            // Allow all other requests (like the Turnstile script itself) to proceed
            request.continue();
         }
      });

      this.logger.info("Navigating to challenge page.");
      await this.challengePage.goto("https://lmarena.ai/", {
         waitUntil: "domcontentloaded"
      });

      // Inject cookieStore if used Chrome version doesn't have it yet
      await page.evaluateOnNewDocument(polyfillContent);
      if (!this.headless) {
         await this.page.bringToFront();
      }
   }

   async getCfToken() {
      if (!this.headless) {
         await this.challengePage.bringToFront();
      }
      const token = await this.challengePage.evaluate(async () => {
         return await new Promise((resolve) => {
            document.getElementById("cf-container").innerHTML = "";
            window.turnstile.render("#cf-container", {
               sitekey: "0x4AAAAAAA65vWDmG-O_lPtT",
               callback: (token) => {
                  resolve(token);
               }
            });
         });
      });
      this.logger.info("Got new CF token.");
      if (!this.headless) {
         await this.page.bringToFront();
      }
      return token;
   }

   // Pass turnstile and get cookies by polling the browser context
   async updateCookies() {
      if (!this.page) {
         throw new Error("Browser not initialized");
      }
      await this.page.goto("https://lmarena.ai/", {
         waitUntil: "domcontentloaded"
      });

      try {
         await this.page.waitForSelector('div[role="dialog"]', {
            timeout: 10000
         });
         this.logger.info(
            "Cookie consent dialog appeared, attempting to accept."
         );
         await this.page.waitForFunction(() => {
            const el = document.querySelector('div[role="dialog"]');
            return (
               el &&
               window.getComputedStyle(el).visibility !== "hidden" &&
               el.offsetHeight > 0
            );
         });
         const [acceptBtn] = await this.page.$$(
            "xpath/.//div[@role='dialog']//button[contains(., 'Accept Cookies')]"
         );
         if (acceptBtn) {
            await acceptBtn.click();
            this.logger.info("Clicked 'Accept Cookies' button.");
         }
      } catch (e) {
         this.logger.warn(
            "Could not find or click cookie consent button, maybe it was already accepted?"
         );
      }
   }

   async getModels() {
      const models = await this.page.evaluate(() => {
         // Access the global array where Next.js stores its data.
         const nextData = window.__next_f;
         if (!nextData || !Array.isArray(nextData)) {
            return [];
         }

         let modelsData = [];

         // Iterate through the data blocks to find the one with model information.
         for (const item of nextData) {
            // Data is often a string in the second element of the inner array.
            if (
               typeof item[1] === "string" &&
               item[1].includes('"initialModels"')
            ) {
               const dataString = item[1];

               // Find the starting point of the initialModels array.
               const searchString = '"initialModels":';
               const startIndex = dataString.indexOf(searchString);
               if (startIndex === -1) {
                  continue; // "initialModels" not found in this block.
               }

               // The actual JSON array starts right after the searchString.
               const arrayStartIndex = startIndex + searchString.length;

               // Find the end of the array by matching brackets to handle nested objects.
               let bracketBalance = 0;
               let arrayEndIndex = -1;
               let firstBracketFound = false;

               for (let i = arrayStartIndex; i < dataString.length; i++) {
                  if (dataString[i] === "[") {
                     if (!firstBracketFound) firstBracketFound = true;
                     bracketBalance++;
                  } else if (dataString[i] === "]") {
                     bracketBalance--;
                  }
                  // When the first bracket is found and the balance returns to 0, we've found the end.
                  if (firstBracketFound && bracketBalance === 0) {
                     arrayEndIndex = i;
                     break;
                  }
               }

               if (arrayEndIndex !== -1) {
                  try {
                     // Extract the array as a string and parse it as JSON.
                     const jsonString = dataString.substring(
                        arrayStartIndex,
                        arrayEndIndex + 1
                     );
                     const parsedModels = JSON.parse(jsonString);

                     // Return the full array of model objects with all their properties.
                     modelsData = parsedModels;
                     break; // Stop searching once the data is found and parsed.
                  } catch (e) {
                     console.error("Failed to parse model data:", e);
                  }
               }
            }
         }
         return modelsData;
      });

      return models;
   }

   /**
    * Waits for a specific cookie to be present in the browser context.
    * @param {string} cookieName - The name of the cookie to wait for.
    * @param {number} [timeout=10000] - The maximum time to wait in milliseconds.
    * @param {number} [interval=500] - The interval at which to check for the cookie.
    * @returns {Promise<string>} The value of the cookie.
    * @throws {Error} If the cookie is not found within the timeout period.
    */
   async waitForCookie(cookieName, timeout = 10000, interval = 500) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
         const allCookies = await this.page.browserContext().cookies();
         const foundCookie = allCookies.find((c) => c.name === cookieName);

         if (foundCookie) {
            // Update the internal cookies object as well
            this.cookies[cookieName] = foundCookie.value;
            return foundCookie.value;
         }
         await new Promise((r) => setTimeout(r, interval));
      }

      throw new Error(`Timeout waiting for cookie: ${cookieName}`);
   }

   /**
    * Waits for a set of cookies to exist in the browser context.
    * @param {string[]} cookieNames - An array of cookie names to wait for.
    * @param {number} [timeout=10000] - The maximum time to wait in milliseconds.
    * @param {number} [interval=500] - The interval at which to check for the cookies.
    * @returns {Promise<void>} Resolves when all cookies are found.
    * @throws {Error} If not all cookies are found within the timeout period.
    */
   async waitForCookies(cookieNames, timeout = 10000, interval = 500) {
      const start = Date.now();
      const requiredCookies = new Set(cookieNames);

      while (Date.now() - start < timeout) {
         const currentCookies = await this.page.browserContext().cookies();
         const foundCookies = new Set();

         for (const cookie of currentCookies) {
            if (requiredCookies.has(cookie.name)) {
               foundCookies.add(cookie.name);
               // Update the internal cookies object
               this.cookies[cookie.name] = cookie.value;
            }
         }

         if (foundCookies.size === requiredCookies.size) {
            // All required cookies have been found
            return;
         }

         await new Promise((r) => setTimeout(r, interval));
      }

      // If the loop finishes, throw an error with the missing cookies
      const currentCookiesSet = new Set(
         (await this.page.browserContext().cookies()).map((c) => c.name)
      );
      const missingCookies = cookieNames.filter(
         (name) => !currentCookiesSet.has(name)
      );
      throw new Error(
         `Timeout waiting for cookies. Missing: ${missingCookies.join(", ")}`
      );
   }
}
