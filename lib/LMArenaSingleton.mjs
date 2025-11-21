import { LMArena } from "./LMArena.mjs";

let lmArenaInstance = null;

/**
 *
 * @returns {Promise<LMArena>}
 */
export async function getLMArena() {
   if (!lmArenaInstance) {
      lmArenaInstance = new LMArena();
      await lmArenaInstance.init(); // only init once
   }
   return lmArenaInstance;
}
