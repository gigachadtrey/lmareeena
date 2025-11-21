import { writeSync, openSync } from "node:fs";
import path from "node:path";

const LOG_DIR = "../logs";

export class Logger {
    constructor(category = "", parent = null){
        this.parent = parent;
        this.category = category;
        if (!this.parent) {
            this.filename = `${new Date().toISOString().replace(/:/g, '-')}${category.length > 0 ? `-${category}` : ""}.log`;
            this.fd = openSync(path.resolve(import.meta.dirname, LOG_DIR, this.filename), "as");
        }
    }

    _log(level, category, ...args) {
        if (this.parent) {
            this.parent._log(level, category, ...args);
            return;
        }
        const message = args.map(arg => {
            if (typeof arg === "string") {
                return arg;
            } else {
                return JSON.stringify(arg, null, 2);
            }
        }).join(" ");
        writeSync(this.fd, `[${category}] [${level}] [${new Date().toISOString()}] ${message}\n`);
    }

    debug(...args) {
        this._log("DEBUG", this.category, ...args);
    }

    info(...args) {
        this._log("INFO", this.category, ...args);
    }

    warn(...args) {
        this._log("WARN", this.category, ...args);
    }

    error(...args) {
        this._log("ERROR", this.category, ...args);
    }

    makeChild(category) {
        return new Logger(category, this);
    }
}