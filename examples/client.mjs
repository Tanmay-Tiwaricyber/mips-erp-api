/**
 * Minimal client for your new ERP project — copy this file.
 */
export class ErpClient {
  constructor(baseUrl = process.env.ERP_API_URL || 'http://localhost:3000') {
    this.base = baseUrl.replace(/\/$/, '');
    this.apiKey = null;
  }

  async #req(path, opts = {}) {
    const res = await fetch(this.base + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...opts.headers,
      },
    });
    const body = await res.json();
    if (!res.ok || body.ok === false) {
      const err = new Error(body?.error?.message || `HTTP ${res.status}`);
      err.code = body?.error?.code;
      err.status = res.status;
      throw err;
    }
    return body.data;
  }

  /** Auto login (server solves the captcha). */
  async login(userId, password, institute = 'MIPS') {
    const data = await this.#req('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ userId, password, institute }),
    });
    this.apiKey = data.apiKey;
    return data;
  }

  /**
   * Manual login — your UI shows `captchaImage` and posts back what the user reads.
   * Retries automatically with the fresh image the API hands back on a wrong answer.
   */
  async loginWithCaptcha(userId, password, { institute = 'MIPS', onCaptcha } = {}) {
    let { sessionId, captchaImage } = await this.#req('/v1/auth/captcha', {
      method: 'POST',
      body: JSON.stringify({ institute }),
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      const captcha = await onCaptcha(captchaImage, attempt);
      const res = await fetch(`${this.base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, userId, password, captcha }),
      });
      const body = await res.json();
      if (body.ok) {
        this.apiKey = body.data.apiKey;
        return body.data;
      }
      if (body.error?.code !== 'INVALID_CAPTCHA') throw Object.assign(new Error(body.error?.message), { code: body.error?.code });
      sessionId = body.data.sessionId;
      captchaImage = body.data.captchaImage; // fresh image, same session
    }
    throw new Error('Captcha attempts exhausted');
  }

  dashboard() { return this.#req('/v1/dashboard'); }
  profile() { return this.#req('/v1/student/profile'); }
  subjects() { return this.#req('/v1/student/subjects'); }
  timetable() { return this.#req('/v1/student/timetable'); }
  attendance() { return this.#req('/v1/student/attendance'); }
  assessment() { return this.#req('/v1/student/assessment'); }
  notices(opts = {}) {
    const q = new URLSearchParams(opts).toString();
    return this.#req('/v1/notices' + (q ? `?${q}` : ''));
  }
  holidays() { return this.#req('/v1/calendar/holidays'); }
  classmates() { return this.#req('/v1/student/classmates'); }
  documents() { return this.#req('/v1/student/documents'); }
  attendanceSummary() {
    return this.attendance().then((a) => a.overall);
  }
  logout() { return this.#req('/v1/auth/logout', { method: 'POST' }); }
}

// ---------------------------------------------------------------- demo
if (import.meta.url === `file://${process.argv[1]}`) {
  const c = new ErpClient(process.env.API_URL);
  const session = await c.login(process.env.ERP_USER, process.env.ERP_PASS, 'MIPS');
  console.log('logged in as', session.user.registrationCode, '| captcha attempts:', session.captchaAttempts);

  const p = await c.profile();
  console.log(`${p.fullName} — ${p.program} ${p.branch}, sem ${p.semester}, ${p.section}`);

  const a = await c.attendanceSummary();
  console.log('attendance:', a.percent, '%', a.source ? `(via ${a.source})` : '');

  const tt = await c.timetable();
  const mon = tt.days.find((d) => d.day === 'Monday');
  console.log('Monday:', mon?.periods.filter(Boolean).map((x) => x.subject || x.type).join(' · '));

  const n = await c.notices({ limit: 3 });
  console.log(`${n.count} notices; newest: ${n.notices[0].date} — ${n.notices[0].title}`);

  await c.logout();
}
