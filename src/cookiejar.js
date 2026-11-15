/**
 * Minimal RFC-6265-ish cookie jar. Enough for a single-origin ERP session.
 */
export class CookieJar {
  constructor() {
    /** @type {Map<string, {value:string, expires:number|null}>} */
    this.cookies = new Map();
  }

  store(url, setCookieHeaders) {
    const host = new URL(url).hostname;
    for (const raw of setCookieHeaders || []) {
      const [pair, ...attrs] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let expires = null;
      let domain = host;
      let expired = false;

      for (const a of attrs) {
        const [k, v] = a.split('=').map((s) => (s || '').trim());
        const key = k.toLowerCase();
        if (key === 'expires' && v) {
          const t = Date.parse(v);
          if (!Number.isNaN(t)) expires = t;
        } else if (key === 'max-age' && v) {
          const secs = Number(v);
          if (!Number.isNaN(secs)) expires = Date.now() + secs * 1000;
          if (secs <= 0) expired = true;
        } else if (key === 'domain' && v) {
          domain = v.replace(/^\./, '').toLowerCase();
        }
      }

      const id = `${domain}\u0000${name}`;
      if (expired || (expires !== null && expires <= Date.now())) {
        this.cookies.delete(id);
      } else {
        this.cookies.set(id, { value, expires, domain });
      }
    }
  }

  header(url) {
    const host = new URL(url).hostname.toLowerCase();
    const parts = [];
    for (const [id, c] of this.cookies) {
      const [domain] = id.split('\u0000');
      if (host === domain || host.endsWith(`.${domain}`)) {
        parts.push(`${id.split('\u0000')[1]}=${c.value}`);
      }
    }
    return parts.join('; ');
  }

  get size() {
    return this.cookies.size;
  }

  toJSON() {
    const out = {};
    for (const [id, c] of this.cookies) out[id.split('\u0000')[1]] = c.value;
    return out;
  }
}
