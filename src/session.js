/**
 * Session — one browser-equivalent conversation with the Asteroid365 ERP.
 *
 * Every student gets their own Session (cookie jar + captcha state). This is what
 * makes the API multi-user: nothing is shared between callers.
 */
import { CookieJar } from './cookiejar.js';

export const BASE = process.env.ERP_BASE_URL || 'https://erp.mpgi.net';

export const UA =
  process.env.ERP_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Known institute ids, discovered from Start.aspx. Override/extend via env or /institutes. */
export const INSTITUTES = {
  MIPS: { id: 'c372c15a-0bdc-4931-a6f7-4798f67fa0e6', name: 'Maharana Institute of Professional Studies', code: '349' },
  MPEC: { id: 'b05cec9c-2415-42e7-8c12-92cd3c4afe4d', name: 'Maharana Pratap Engineering College', code: '046' },
  MIPSC: { id: '55520610-2a9f-4d9a-9b7f-8427b7e6402e', name: 'Maharana Pratap College of Pharmaceutical Science', code: '889' },
  MIPS_PARAMED: { id: 'b2e19fe8-1bb5-4a02-8953-9e0e42ae850f', name: 'Maharana Pratap College of Pharmacy and Paramedical Science', code: '3036' },
  MCOPS: { id: 'ab0d4edc-07f0-45de-aac9-9917b3ea16ef', name: 'Maharana Pratap College of Pharmacy', code: '200' },
  MIPS_PROF: { id: 'bee55fb0-49fd-4914-8ad1-687b01c9e329', name: 'Maharana Pratap College of Professional Studies', code: 'KN142' },
};

/** LoginStatus codes returned by UserServiceWS.asmx/AuthenticateUser */
export const LOGIN_STATUS = {
  1: 'INCORRECT_PASSWORD',   // valid user id, wrong password — ERP also emails credentials
  5: 'INVALID_CREDENTIALS',
  8: 'MESSAGE',
  9: 'INVALID_CAPTCHA',
  15: 'SUCCESS',
};

export class ErpError extends Error {
  constructor(message, { status = 502, code = 'ERP_ERROR', upstream = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.upstream = upstream;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class Session {
  /**
   * @param {object} opts
   * @param {string} [opts.institute] institute key ('MIPS') or raw uuid
   */
  constructor({ institute = 'MIPS' } = {}) {
    const inst = INSTITUTES[institute] || Object.values(INSTITUTES).find((i) => i.id === institute);
    if (!inst) {
      throw new ErpError(`Unknown institute "${institute}". Pass a known key or the raw institute uuid.`, {
        status: 400,
        code: 'UNKNOWN_INSTITUTE',
      });
    }
    this.institute = inst.id;
    this.instituteName = inst.name;
    this.jar = new CookieJar();
    this.authenticated = false;
    this.user = null;
    this.captcha = null; // { image: Buffer, mime, at }
    this.lastUsed = Date.now();
    this.loginPageLoaded = false;
  }

  touch() {
    this.lastUsed = Date.now();
  }

  /** Low-level request through the cookie jar. */
  async request(path, { method = 'GET', json, form, headers = {}, redirect = 'manual' } = {}) {
    const url = path.startsWith('http') ? path : `${BASE}/${path.replace(/^\/+/, '')}`;
    const h = {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `${BASE}/index.aspx?openFor=Students&institute=${this.institute}`,
      Origin: BASE,
      ...headers,
    };
    let body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      h['Content-Type'] = 'application/json; charset=utf-8';
      h.Accept = 'application/json, text/javascript, */*; q=0.01';
      h['X-Requested-With'] = 'XMLHttpRequest';
    } else if (form !== undefined) {
      body = new URLSearchParams(form).toString();
      h['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const cookie = this.jar.header(url);
    if (cookie) h.Cookie = cookie;

    let res;
    try {
      res = await fetch(url, { method, headers: h, body, redirect });
    } catch (err) {
      throw new ErpError(`Cannot reach ${BASE}: ${err.message}`, { status: 502, code: 'UPSTREAM_UNREACHABLE' });
    }
    this.jar.store(url, res.headers.getSetCookie?.() || []);

    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf, text: buf.toString('utf8'), status: res.status };
  }

  /** POST to an ASP.NET page-method / asmx webmethod and unwrap the { d: ... } envelope. */
  async ajax(path, payload = {}, { method = 'POST' } = {}) {
    const { res, text, status } = await this.request(path, { method, json: payload });
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ErpError(`Non-JSON response from ${path}`, {
        status: 502,
        code: 'BAD_UPSTREAM_RESPONSE',
        upstream: { httpStatus: status, snippet: text.slice(0, 400) },
      });
    }
    if (parsed && parsed.Message && parsed.ExceptionType !== undefined && parsed.d === undefined) {
      throw new ErpError(`ERP rejected ${path}: ${parsed.Message}`, {
        status: 502,
        code: 'ERP_CALL_FAILED',
        upstream: parsed,
      });
    }
    if (!('d' in parsed)) {
      throw new ErpError(`Unexpected envelope from ${path}`, {
        status: 502,
        code: 'BAD_UPSTREAM_RESPONSE',
        upstream: { snippet: text.slice(0, 400) },
      });
    }
    return parsed.d;
  }

  /** GET an HTML page (used for the login form and a few non-AJAX pages). */
  async page(path) {
    const { text, status, res } = await this.request(path, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
    });
    return { html: text, status, finalUrl: res.url };
  }

  // ---------------------------------------------------------------- auth flow

  /** Step 1 — establish session cookies and confirm the login page is reachable. */
  async openLogin() {
    const { status } = await this.page(`index.aspx?openFor=Students&institute=${this.institute}`);
    if (status >= 400) throw new ErpError('Login page unavailable', { code: 'LOGIN_PAGE_UNAVAILABLE' });
    this.loginPageLoaded = true;
    return true;
  }

  /** Step 2 — fetch a captcha image bound to this session. */
  async fetchCaptcha() {
    if (!this.loginPageLoaded) await this.openLogin();
    const { buf, res, status } = await this.request(
      `captchaHandler.ashx?query=${Date.now()}${Math.random()}`,
      { headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' } }
    );
    if (status !== 200 || !buf.length) {
      throw new ErpError('Captcha fetch failed', { code: 'CAPTCHA_UNAVAILABLE' });
    }
    this.captcha = {
      image: buf,
      mime: res.headers.get('content-type') || 'image/jpeg',
      at: Date.now(),
    };
    return this.captcha;
  }

  /** Step 3 — submit credentials + captcha answer. Raw upstream result. */
  async submitLogin(userId, password, captchaText) {
    return this.ajax('json/UserServiceWS.asmx/AuthenticateUser', {
      userId,
      passwds: password,
      vcaptcha: captchaText,
      openFor: 'Students',
      institute: this.institute,
    });
  }

  /**
   * Load the dashboard shell once. Several student panels (notably My Subjects)
   * silently return an empty result until the portal has served the dashboard at
   * least once in this session — the page render seeds server-side session state.
   * Cheap (one HTML GET) and makes the rest of the API deterministic.
   */
  async primeDashboard() {
    try {
      const { html, status } = await this.page('Dashboard?title=Dashboard');
      if (status === 200 && /hidServerDateTime/.test(html)) {
        this.serverDateTime = (html.match(/id="ctl00_hidServerDateTime"[^>]*value="([^"]+)"/) || [])[1] || null;
        this.dashboardPrimed = true;
      }
      return this.dashboardPrimed === true;
    } catch {
      return false;
    }
  }

  /** Step 4 — pick the Student role (required before the dashboard opens). */
  async selectStudentRole() {
    const roles = await this.ajax('chooseURole.aspx/getRoles', {});
    if (!Array.isArray(roles) || !roles.length) {
      throw new ErpError('No roles assigned to this account', { status: 409, code: 'NO_ROLE' });
    }
    const role =
      roles.find((r) => /student/i.test(r.roleName_P || '')) || roles.find((r) => r.status_P === 'A') || roles[0];
    const nav = await this.ajax('chooseURole.aspx/btnNext_Click', { rId: role.roleId_P });
    this.role = role.roleName_P;
    this.navigateUrl = nav;
    return { role, navigateUrl: nav };
  }

  /**
   * Full manual-captcha login: caller supplies the solved text.
   * Returns { ok: true } or throws / returns a structured failure.
   */
  async login(userId, password, captchaText) {
    const d = await this.submitLogin(userId, password, captchaText);
    const status = Number(d.LoginStatus);
    // The portal is inconsistent about the failure code (5 for a bad institute,
    // 1 for a bad password on a valid one), so fall back to the message text.
    let label = LOGIN_STATUS[status] || `UNKNOWN_${status}`;
    const msg = String(d.Message || '');
    if (label.startsWith('UNKNOWN_') && /invalid user name or password/i.test(msg)) {
      label = 'INVALID_CREDENTIALS';
    } else if (label.startsWith('UNKNOWN_') && /captcha/i.test(msg)) {
      label = 'INVALID_CAPTCHA';
    } else if (label.startsWith('UNKNOWN_') && /incorrect password/i.test(msg)) {
      label = 'INCORRECT_PASSWORD';
    }

    if (status === 15) {
      this.authenticated = true;
      this.user = { userId, registrationCode: userId.toUpperCase(), profilePicUrl: d.ProfilePicUrl, profileSigUrl: d.ProfileSigUrl };
      await this.selectStudentRole();
      await this.primeDashboard(); // seed session state so panel APIs return data
      this.touch();
      return { ok: true, status, label, navigateUrl: this.navigateUrl, primed: !!this.dashboardPrimed };
    }
    return {
      ok: false,
      status,
      label,
      message: label === 'INCORRECT_PASSWORD'
        ? 'Incorrect password for this user ID.'
        : String(d.Message || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
      // The ERP e-mails the account's credentials on a wrong password. We surface
      // only that fact — never the e-mail address itself.
      credentialsEmailed: label === 'INCORRECT_PASSWORD',
      invalidLoginAttempt: d.InvalidLoginAttempt,
      // Only captcha failures are safe to retry: they don't increment
      // InvalidLoginAttempt. A wrong password DOES count, and re-trying it makes
      // the ERP re-send the credential e-mail to the student.
      retryable: label === 'INVALID_CAPTCHA',
    };
  }

  toString() {
    return `Session(${this.user?.userId || 'anonymous'} @ ${this.instituteName})`;
  }
}

export { sleep };
