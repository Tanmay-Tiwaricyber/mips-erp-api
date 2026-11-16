/**
 * eLOGiPay (fee portal) client + parser.
 *
 * A completely separate system from the ERP in ./session.js:
 *
 *   ERP      https://erp.mpgi.net      attendance, timetable, marks   ~33% OCR captcha
 *   eLOGiPay https://www.elogisol.com  fees, dues, receipts           captcha is PLAIN TEXT
 *
 * The eLOGiPay captcha is rendered into the HTML as
 * `<span id="TxtCaptcha">3336</span>` — so there is no OCR step and no retry
 * loop. Login is one GET + one POST, no failure modes beyond bad credentials.
 *
 * Same public shape as Session so it can sit behind the same routes:
 *   - `get(path)` / `post(path, body)` return { status, text, headers }
 *   - `authenticated`, `user`, `touch()` for the session registry
 */

export const PAY_BASE = 'https://www.elogisol.com/mpgi/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Thrown for anything the caller should see as a clean API error. */
export class PayError extends Error {
  constructor(message, { status = 500, code = 'PAY_ERROR', upstream } = {}) {
    super(message);
    this.name = 'PayError';
    this.status = status;
    this.code = code;
    if (upstream !== undefined) this.upstream = upstream;
  }
}

/** Decode the handful of entities ASP.NET emits into attribute values. */
const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();

/** Pull every `<input type="hidden">` into a plain object (VIEWSTATE etc.). */
function hiddenFields(html) {
  const out = {};
  for (const m of String(html).matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/name="([^"]+)"/i) || [])[1];
    const value = (tag.match(/value="([^"]*)"/i) || [])[1];
    if (name) out[name] = decodeEntities(value);
  }
  return out;
}

/**
 * The login captcha is plain text in the page. Returns null if the markup ever
 * changes, so the caller can fall back to manual entry instead of guessing.
 */
export function readCaptcha(html) {
  const m = String(html).match(/id="TxtCaptcha"[^>]*>\s*([^<\s]+)\s*</i);
  return m ? m[1] : null;
}

export class PaySession {
  constructor() {
    this.jar = new Map();
    this.authenticated = false;
    this.user = null;
    this.createdAt = Date.now();
    this.lastUsed = Date.now();
  }

  touch() {
    this.lastUsed = Date.now();
  }

  #store(res) {
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of cookies) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }

  #cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #headers(extra = {}) {
    const h = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: PAY_BASE,
      ...extra,
    };
    const cookie = this.#cookieHeader();
    if (cookie) h.Cookie = cookie;
    return h;
  }

  async get(path, { referer } = {}) {
    const url = path.startsWith('http') ? path : PAY_BASE + path.replace(/^\/+/, '');
    let res;
    try {
      res = await fetch(url, {
        headers: this.#headers(referer ? { Referer: referer } : {}),
        redirect: 'manual',
      });
    } catch (err) {
      throw new PayError(`Cannot reach ${PAY_BASE}: ${err.message}`, {
        status: 502,
        code: 'UPSTREAM_UNREACHABLE',
      });
    }
    this.#store(res);
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  }

  async post(path, body, { referer } = {}) {
    const url = path.startsWith('http') ? path : PAY_BASE + path.replace(/^\/+/, '');
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.#headers({
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://www.elogisol.com',
          ...(referer ? { Referer: referer } : {}),
        }),
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      });
    } catch (err) {
      throw new PayError(`Cannot reach ${PAY_BASE}: ${err.message}`, {
        status: 502,
        code: 'UPSTREAM_UNREACHABLE',
      });
    }
    this.#store(res);
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  }

  /** GET the login page and read its captcha + viewstate. */
  async openLogin() {
    const page = await this.get(PAY_BASE);
    if (page.status >= 400) {
      throw new PayError('eLOGiPay login page unavailable', { status: 502, code: 'LOGIN_PAGE_UNAVAILABLE' });
    }
    this.loginPage = page.text;
    return { captcha: readCaptcha(page.text), fields: hiddenFields(page.text) };
  }

  /**
   * Log in. One attempt — a wrong password here does NOT trigger credential
   * e-mails or lockouts the way the ERP does, but we still never auto-retry
   * credentials, only surface the failure.
   */
  async login(enrollmentNo, password) {
    const { captcha, fields } = await this.openLogin();
    if (!captcha) {
      throw new PayError('Could not read the eLOGiPay captcha from the login page', {
        status: 502,
        code: 'CAPTCHA_UNAVAILABLE',
      });
    }

    const res = await this.post(
      PAY_BASE,
      {
        __EVENTTARGET: '',
        __EVENTARGUMENT: '',
        __LASTFOCUS: '',
        __VIEWSTATE: fields.__VIEWSTATE || '',
        __VIEWSTATEGENERATOR: fields.__VIEWSTATEGENERATOR || '',
        __EVENTVALIDATION: fields.__EVENTVALIDATION || '',
        textUserName: enrollmentNo,
        textPassword: password,
        txtEntCaptcha: captcha,
        hdnwrongloginattempts: fields.hdnwrongloginattempts || '0',
        hdnStatus: fields.hdnStatus || '0',
        btnLogin: 'Sign in',
      },
      PAY_BASE
    );

    // Success is a 302 to Home.aspx. Anything else is a re-rendered login page.
    const location = res.headers.get('location') || '';
    if (res.status === 302 && /Home\.aspx/i.test(location)) {
      this.authenticated = true;
      this.user = { enrollmentNo: String(enrollmentNo) };
      this.touch();
      await this.#hydrateIdentity();
      return { ok: true, captchaUsed: true, navigateTo: location };
    }

    // Surface the page's own message rather than inventing one.
    const msg =
      decodeEntities((res.text.match(/id="lblMessage"[^>]*>([^<]*)</i) || [])[1] || '') ||
      decodeEntities((res.text.match(/alert\(['"]([^'"]{3,160})['"]\)/i) || [])[1] || '');
    const attempts = Number((res.text.match(/id="hdnwrongloginattempts"[^>]*value="(\d+)"/i) || [])[1] || 0);
    return {
      ok: false,
      reason: /captcha/i.test(msg) ? 'INVALID_CAPTCHA' : 'INVALID_CREDENTIALS',
      message: msg || 'Sign in failed — check the enrollment number and password.',
      wrongLoginAttempts: attempts,
    };
  }

  /** Name/branch/course live in the nav bar of every logged-in page. */
  async #hydrateIdentity() {
    try {
      const home = await this.get('Home.aspx');
      const m = home.text.match(/id="lblUserName"[^>]*>([^<]*)</i) ||
        home.text.match(/>([A-Z][A-Z\s.]{4,40}\([^)]{2,30}\))</);
      if (m) this.user.name = decodeEntities(m[1]);
    } catch {
      /* identity is cosmetic — never fail login over it */
    }
  }

  /** Fetch the Outstanding Report (the one page that carries real data). */
  async outstandingReport() {
    const res = await this.get('Commercial/StudentQueryOnline.aspx', PAY_BASE + 'Home.aspx');
    if (res.status !== 200) {
      throw new PayError('eLOGiPay outstanding report unavailable', {
        status: 502,
        code: 'REPORT_UNAVAILABLE',
      });
    }
    // A logged-out session gets bounced back to the login form.
    if (/id="txtUserName"/i.test(res.text) && !/repIndentDetails/i.test(res.text)) {
      throw new PayError('eLOGiPay session expired — log in again', {
        status: 401,
        code: 'SESSION_EXPIRED',
      });
    }
    return res.text;
  }

  /** Fetch the Fee Receipt page (receipt list). */
  async feeReceiptsPage() {
    const res = await this.get('Commercial/MyFees.aspx', PAY_BASE + 'Home.aspx');
    if (res.status !== 200) {
      throw new PayError('eLOGiPay fee receipt page unavailable', {
        status: 502,
        code: 'REPORT_UNAVAILABLE',
      });
    }
    if (/id="txtUserName"/i.test(res.text) && !/Fee Receipt/i.test(res.text)) {
      throw new PayError('eLOGiPay session expired — log in again', {
        status: 401,
        code: 'SESSION_EXPIRED',
      });
    }
    return res.text;
  }
}
