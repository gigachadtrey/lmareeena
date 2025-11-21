/**
 * Parses a custom multi-part JSON response with references (e.g., "$@1")
 * and returns a single, fully hydrated JavaScript object.
 *
 * @param {string} responseText The raw multi-line response text.
 * @returns {object} The fully assembled JavaScript object.
 * @throws {Error} If parsing fails or a reference is invalid.
 */
export function parseAndDereference(responseText) {
   if (!responseText || typeof responseText !== "string") {
      return null;
   }

   const dataMap = new Map();
   const lines = responseText.trim().split("\n");

   for (const line of lines) {
      if (!line) continue;

      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) {
         console.warn("Skipping malformed line (no colon):", line);
         continue;
      }

      const id = line.substring(0, separatorIndex);
      const content = line.substring(separatorIndex + 1);

      // --- START OF THE FIX ---
      // The RSC payload includes non-JSON instructions for the client (e.g., 'I[...]').
      // We only want to parse lines that contain actual JSON.
      // A simple check on the first character is sufficient to filter out these instructions.
      const firstChar = content.charAt(0);
      if (firstChar !== "{" && firstChar !== "[" && firstChar !== '"') {
         // This is likely a client-side instruction, not JSON data.
         // We can safely ignore it for our purposes.
         continue;
      }
      // --- END OF THE FIX ---

      try {
         dataMap.set(id, JSON.parse(content));
      } catch (e) {
         // This error will now only trigger for genuinely malformed JSON.
         throw new Error(
            `Failed to parse JSON for ID "${id}": ${e.message} | Content: ${content}`
         );
      }
   }

   const rootId = "0";
   if (!dataMap.has(rootId)) {
      throw new Error("Could not find the root object with ID '0'.");
   }

   function dereference(value) {
      if (typeof value === "string") {
         const match = value.match(/^\$@(\d+)$/);
         if (match) {
            const refId = match[1];
            if (dataMap.has(refId)) {
               return dereference(dataMap.get(refId));
            } else {
               // The reference might be to one of the non-JSON lines we skipped.
               // In our case, this is fine as we don't need that data.
               // We return null or a placeholder.
               return null;
            }
         }
      }

      if (Array.isArray(value)) {
         return value.map((item) => dereference(item));
      }

      if (value !== null && typeof value === "object") {
         const newObj = {};
         for (const key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
               newObj[key] = dereference(value[key]);
            }
         }
         return newObj;
      }

      return value;
   }

   return dereference(dataMap.get(rootId));
}

// Log filtering for support requests

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
/**
 * Read and filter logs by exact supportId.
 *
 * - Accepts filenames using either ":" or "-" between time components:
 *     2025-11-03T20:59:14.418Z-command-usage.log
 *     2025-11-03T20-59-14.418Z-command-usage.log
 * - Matches lines like:
 *     [command-usage] [DEBUG] [2025-11-03T21:00:07.314Z] {"event":...,"supportId":"2fb260"} ...
 *   even if there's trailing text after the JSON.
 *
 * @param {object} opts
 * @param {string} opts.logDir
 * @param {string} opts.supportId
 * @param {string} [opts.category='command-usage']
 * @param {string|Date} [opts.startDate]
 * @param {string|Date} [opts.endDate]
 * @returns {Promise<Array<{ timestamp: string, event?: string, raw: object, file: string, line: number }>>}
 */
export async function getLogsForSupportId({
  logDir,
  supportId,
  category = "command-usage",
  startDate,
  endDate
}) {
  const results = [];
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;

  // Allow either ":" or "-" between time components in the filename
  const timeSep = "[:\\-]"; // either ':' or '-'
  const filenamePattern = new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}T\\d{2}${timeSep}\\d{2}${timeSep}\\d{2}\\.\\d{3}Z-${escapeRegex(category)}\\.log$`
  );

  const files = fs.readdirSync(logDir).filter((f) => filenamePattern.test(f));

  for (const file of files) {
    const filePath = path.join(logDir, file);
    const stream = fs.createReadStream(filePath, "utf8");
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;

    for await (const line of rl) {
      lineNo++;

      // Match the prefix with timestamp: [category] [DEBUG] [ISO]
      // We capture the timestamp and the remainder of the line after the timestamp.
      const prefixRegex = new RegExp(`^\\[${escapeRegex(category)}\\] \\[DEBUG\\] \\[(.*?)\\] (.*)$`);
      const prefixMatch = line.match(prefixRegex);
      if (!prefixMatch) continue;

      const [, isoTime, afterTimestamp] = prefixMatch;

      // Date range filter
      const ts = new Date(isoTime);
      if (Number.isNaN(ts.getTime())) continue; // invalid timestamp
      if (start && ts < start) continue;
      if (end && ts > end) continue;

      // Try to extract the first JSON object substring on the line.
      // This uses a simple { ... } match across the line (non-greedy).
      // It will match the first {...}. If you have nested JSON objects inside strings with braces,
      // more advanced parsing would be required, but this works for normal JSON logs.
      const jsonMatch = afterTimestamp.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) continue; // no JSON object on this line

      const jsonText = jsonMatch[0];

      try {
        const obj = JSON.parse(jsonText);

        // Exact supportId match
        if (obj.supportId === supportId) {
          results.push({
            timestamp: isoTime,
            event: obj.event,
            raw: obj,
            file,
            line: lineNo
          });
        }
      } catch (err) {
        // If parse fails, skip this line (malformed JSON)
        continue;
      }
    }
  }

  return results;
}

/** Escape text for usage inside new RegExp(...) */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


export function generateSupportId() {
   return "ls" + randomBytes(3).toString("hex");
}