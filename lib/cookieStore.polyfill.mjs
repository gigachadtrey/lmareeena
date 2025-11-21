/*
    cookieStore polyfill
    Description: Lightweight polyfill for the Cookie Store API (cookieStore) using document.cookie.

    Limitations (important):
    - Browsers expose only name=value pairs via document.cookie; path, domain, secure, SameSite, and httpOnly cannot be read back.
    - Because of that, this polyfill cannot faithfully represent cookies that differ only by path/domain.
    - This polyfill is intended for same-origin, non-httpOnly cookies and for environments that need the promise-based API and change events for JS-driven changes.

    API implemented (subset):
    - cookieStore.get(name) -> Promise<Cookie | undefined>
    - cookieStore.getAll([name]) -> Promise<Cookie[]>
    - cookieStore.set({name, value, path, domain, maxAge, expires, secure, sameSite}) -> Promise<void>
    - cookieStore.set(name, value, options) (alternate signature)
    - cookieStore.delete(name, options) -> Promise<void>
    - cookieStore.addEventListener('change', handler)
    - cookieStore.removeEventListener('change', handler)
    - cookieStore.onchange = handler

    Cookie shape returned: { name, value, domain: undefined, path: undefined, secure: undefined, sameSite: undefined, expires: undefined }

    Example usage:
    await cookieStore.set({ name: 'foo', value: 'bar', path: '/' });
    const c = await cookieStore.get('foo');
    await cookieStore.delete('foo');
*/
(function () {
    if (typeof window === "undefined") return; // non-browser
    if ("cookieStore" in window) return; // already exists

    // Helpers
    const encode = (s) => encodeURIComponent(String(s));
    const decode = (s) => {
        try {
            return decodeURIComponent(s);
        } catch (e) {
            return s;
        }
    };

    function parseDocumentCookie() {
        // Parse document.cookie into an array of {name, value}
        const raw = document.cookie || "";
        if (!raw) return [];
        return raw
            .split(";")
            .map((part) => {
                const idx = part.indexOf("=");
                if (idx === -1) return null;
                const name = part.slice(0, idx).trim();
                const value = part.slice(idx + 1).trim();
                return { name: decode(name), value: decode(value) };
            })
            .filter(Boolean);
    }

    function findCookie(name) {
        const all = parseDocumentCookie();
        // If multiple cookies with same name exist, pick the last (document.cookie returns them in order of creation; picking last is pragmatic)
        for (let i = all.length - 1; i >= 0; i--) {
            const c = all[i];
            if (c.name === name) return c;
        }
        return undefined;
    }

    function buildSetCookieString(name, value, opts = {}) {
        let str = `${encode(name)}=${encode(value)}`;
        if (opts.maxAge != null) {
            // maxAge in seconds
            str += `; Max-Age=${Number(opts.maxAge)}`;
        }
        if (opts.expires != null) {
            let date = opts.expires;
            if (typeof date === "number") date = new Date(date);
            if (
                date instanceof Date &&
                !Number.isNaN(date.getTime())
            ) {
                str += `; Expires=${date.toUTCString()}`;
            }
        }
        if (opts.domain) str += `; Domain=${opts.domain}`;
        if (opts.path) str += `; Path=${opts.path}`;
        if (opts.secure) str += `; Secure`;
        if (opts.sameSite) {
            // Accept Lax, Strict, None (case-insensitive)
            const ss =
                String(opts.sameSite).charAt(0).toUpperCase() +
                String(opts.sameSite).slice(1);
            str += `; SameSite=${ss}`;
        }
        return str;
    }

    // Simple EventTarget-like implementation for cookie change events
    class ChangeEventTarget {
        constructor() {
            this.listeners = new Map(); // type -> Set
        }
        addEventListener(type, fn) {
            if (!this.listeners.has(type))
                this.listeners.set(type, new Set());
            this.listeners.get(type).add(fn);
        }
        removeEventListener(type, fn) {
            if (!this.listeners.has(type)) return;
            this.listeners.get(type).delete(fn);
        }
        dispatchEvent(ev) {
            const set = this.listeners.get(ev.type);
            if (set) {
                for (const fn of Array.from(set)) {
                    try {
                        fn.call(null, ev);
                    } catch (e) {
                        console.error(e);
                    }
                }
            }
            // support onchange property
            const onprop = this["on" + ev.type];
            if (typeof onprop === "function") {
                try {
                    onprop.call(null, ev);
                } catch (e) {
                    console.error(e);
                }
            }
        }
    }

    class CookieStorePolyfill extends ChangeEventTarget {
        constructor() {
            super();
            this.type = "cookieStore";
        }

        // get(name)
        get(name) {
            return Promise.resolve().then(() => {
                if (typeof name !== "string")
                    throw new TypeError("name must be a string");
                const found = findCookie(name);
                if (!found) return undefined;
                return { name: found.name, value: found.value };
            });
        }

        // getAll([name])
        getAll(filter) {
            return Promise.resolve().then(() => {
                const arr = parseDocumentCookie();
                if (!filter)
                    return arr.map((c) => ({
                        name: c.name,
                        value: c.value
                    }));
                // If filter is string -> name
                if (typeof filter === "string") {
                    return arr
                        .filter((c) => c.name === filter)
                        .map((c) => ({ name: c.name, value: c.value }));
                }
                // If filter is object with name
                if (
                    typeof filter === "object" &&
                    filter !== null &&
                    filter.name
                ) {
                    return arr
                        .filter((c) => c.name === filter.name)
                        .map((c) => ({ name: c.name, value: c.value }));
                }
                return arr.map((c) => ({
                    name: c.name,
                    value: c.value
                }));
            });
        }

        // set(name, value, opts) OR set({name, value, ...opts})
        set(nameOrObj, valueOrOpts, maybeOpts) {
            return Promise.resolve().then(() => {
                let name, value, opts;
                if (
                    typeof nameOrObj === "object" &&
                    nameOrObj !== null
                ) {
                    name = nameOrObj.name;
                    value = nameOrObj.value;
                    opts = nameOrObj;
                } else {
                    name = nameOrObj;
                    value = valueOrOpts;
                    opts = maybeOpts || {};
                }
                if (typeof name !== "string")
                    throw new TypeError("name must be a string");
                if (value == null) value = "";
                const old = findCookie(name);
                const oldValue = old ? old.value : null;

                // Build cookie string and set it via document.cookie
                const cookieStr = buildSetCookieString(
                    name,
                    value,
                    opts
                );
                document.cookie = cookieStr;

                // Dispatch cookiechange event
                const changed = [
                    {
                        name,
                        oldValue,
                        newValue: String(value),
                        url: location.href
                    }
                ];
                const ev = { type: "change", changed, deleted: [] };
                this.dispatchEvent(ev);
            });
        }

        // delete(name, options)
        delete(name, opts = {}) {
            return Promise.resolve().then(() => {
                if (typeof name !== "string")
                    throw new TypeError("name must be a string");
                const old = findCookie(name);
                const oldValue = old ? old.value : null;
                // To delete, set Max-Age=0 (or Expires in the past)
                const kill = Object.assign({}, opts, { maxAge: 0 });
                document.cookie = buildSetCookieString(name, "", kill);

                const deleted = [
                    { name, oldValue, url: location.href }
                ];
                const ev = { type: "change", changed: [], deleted };
                this.dispatchEvent(ev);
            });
        }

        // EventTarget-like aliases
        addEventListener(type, fn) {
            super.addEventListener(type, fn);
        }
        removeEventListener(type, fn) {
            super.removeEventListener(type, fn);
        }

        // onchange property will be handled by ChangeEventTarget
    }

    // Install
    try {
        Object.defineProperty(window, "cookieStore", {
            configurable: true,
            enumerable: true,
            writable: false,
            value: new CookieStorePolyfill()
        });
    } catch (e) {
        // Fallback assignment
        window.cookieStore = new CookieStorePolyfill();
    }

    if (typeof console !== "undefined" && console.info) {
        console.info(
            "cookieStore polyfill installed. Note: httpOnly cookies and per-path/domain distinctions are not visible to scripts."
        );
    }
})();
