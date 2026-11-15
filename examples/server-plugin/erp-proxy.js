/**
 * erp-proxy.js — per-user authentication for your ERP app (web + Android).
 *
 * The model you asked for:
 *   1. User types THEIR user id + password in your app.
 *   2. Your backend logs into mips-erp-api as that user and gets a private ERP session.
 *   3. Your backend hands the app an opaque token bound to that user.
 *   4. Every later call uses the token → that user's own data.
 *
 * Design rules enforced here:
 *   - There is NO shared/server-side account. Every token traces back to one real login.
 *   - Passwords are never stored, never logged, and never leave the login call.
 *   - Tokens are bound to a userId; each token maps to its own isolated ERP session.
 *   - A wrong password is rejected at login and never produces a token.
 *   - When the ERP session expires, the app gets SESSION_EXPIRED and must re-prompt
 *     for the password (we cannot refresh it silently — we don't keep it).
 *
 * Mount it:
 *   import { createErpProxy } from './erp-proxy.js';
 *   app.use('/api/erp', createErpProxy({ apiBase: process.env.MIPS_ERP_API_URL }));
 */
import crypto from 'node:crypto';
import express from 'express';

export function createErpProxy({
  apiBase = process.env.MIPS_ERP_API_URL || 'http://localhost:3000',
  /** Only used if you deliberately want a demo/anonymous account. Leave null for real per-user auth. */
  demoAccount = null,
  tokenTtlMs = Number(process.env.ERP_TOKEN_TTL_MS || 20 * 60 * 1000), // ERP sessions idle out ~25 min
  timeoutMs = Number(process.env.ERP_TIMEOUT_MS || 75000),
  maxSessionsPerUser = Number(process.env.ERP_MAX_SESSIONS_PER_USER || 3),
  // Brute-force protection. The ERP itself locks accounts, so this matters.
  loginAttempts = Number(process.env.ERP_LOGIN_ATTEMPTS || 8),
  loginWindowMs = Number(process.env.ERP_LOGIN_WINDOW_MS || 10 * 60 * 1000),
  onLogin = null, // optional audit hook: ({ userId, ok, ip, attempts })
} = {}) {
  const base = apiBase.replace(/\/+$/, '');
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  /** token -> { apiKey, userId, user, createdAt, lastUsed } */
  const sessions = new Map();
  /** ip -> { count, reset } */
  const attempts = new Map();

  // ---------------------------------------------------------------- helpers

  async function erpCall(path, { apiKey, method = 'GET', body } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(json?.error?.message || `Upstream ${res.status}`);
        err.status = res.status;
        err.code = json?.error?.code || `UPSTREAM_${res.status}`;
        err.data = json?.data;
        throw err;
      }
      return json?.data !== undefined ? json.data : json;
    } catch (e) {
      if (e.name === 'AbortError') {
        const err = new Error('The college ERP took too long to respond. Please try again.');
        err.status = 504;
        err.code = 'ERP_TIMEOUT';
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function rateLimited(ip) {
    const now = Date.now();
    const rec = attempts.get(ip) || { count: 0, reset: now + loginWindowMs };
    if (now > rec.reset) {
      rec.count = 0;
      rec.reset = now + loginWindowMs;
    }
    attempts.set(ip, rec);
    return rec.count >= loginAttempts;
  }

  function recordAttempt(ip) {
    const rec = attempts.get(ip) || { count: 0, reset: Date.now() + loginWindowMs };
    rec.count += 1;
    attempts.set(ip, rec);
  }

  function clearAttempts(ip) {
    attempts.delete(ip);
  }

  function sessionsForUser(userId) {
    const out = [];
    for (const [token, s] of sessions) if (s.userId === userId) out.push([token, s]);
    return out.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  }

  function mintToken(userId, data) {
    // keep only the N most recent sessions per user
    const existing = sessionsForUser(userId);
    while (existing.length >= maxSessionsPerUser) {
      const [oldestToken, oldest] = existing.shift();
      erpCall('/v1/auth/logout', { method: 'POST', apiKey: oldest.apiKey }).catch(() => {});
      sessions.delete(oldestToken);
    }
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(token, {
      apiKey: data.apiKey,
      userId,
      user: data.user,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      captchaAttempts: data.captchaAttempts,
    });
    return token;
  }

  // ---------------------------------------------------------------- auth

  /**
   * POST /api/erp/login   { userId, password, institute? }
   * → { token, user }   401 if the credentials are wrong.
   */
  router.post('/login', async (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const userId = String(req.body?.userId || '').trim();
    const password = String(req.body?.password || '');
    const institute = req.body?.institute || 'MIPS';

    if (!userId || !password) {
      return res.status(400).json({
        error: { code: 'MISSING_CREDENTIALS', message: 'User ID and password are required.' },
      });
    }

    if (rateLimited(ip)) {
      return res.status(429).json({
        error: {
          code: 'TOO_MANY_ATTEMPTS',
          message: 'Too many login attempts. Please wait a few minutes and try again.',
        },
      });
    }

    try {
      // Real per-user login. No server-side fallback: these are the user's own credentials.
      const data = await erpCall('/v1/auth/login', {
        method: 'POST',
        body: { userId, password, institute },
      });

      clearAttempts(ip);
      const token = mintToken(userId, data);
      onLogin?.({ userId, ok: true, ip, attempts: data.captchaAttempts });

      return res.json({
        token,
        user: {
          userId: data.user?.userId ?? userId,
          registrationCode: data.user?.registrationCode ?? userId,
          profilePicUrl: data.user?.profilePicUrl ?? null,
        },
        role: data.role,
        expiresInSeconds: Math.floor(tokenTtlMs / 1000),
        captchaAttempts: data.captchaAttempts,
      });
    } catch (e) {
      // Only count real credential failures toward the brute-force budget.
      if (e.code === 'INVALID_CREDENTIALS' || e.code === 'INCORRECT_PASSWORD') recordAttempt(ip);
      onLogin?.({ userId, ok: false, ip, code: e.code });

      if (e.code === 'INVALID_CREDENTIALS' || e.code === 'INCORRECT_PASSWORD') {
        return res.status(401).json({
          error: {
            code: e.code,
            message:
              e.code === 'INCORRECT_PASSWORD'
                ? 'Incorrect password for this user ID.'
                : 'Incorrect user ID or password. Please check and try again.',
            // The ERP e-mails the account's credentials on a wrong password.
            // Tell the user once; do not encourage retrying.
            ...(e.code === 'INCORRECT_PASSWORD'
              ? { notice: 'The college ERP has e-mailed your registered address with your current credentials.' }
              : {}),
          },
        });
      }
      if (e.code === 'CAPTCHA_OCR_FAILED') {
        return res.status(503).json({
          error: {
            code: 'CAPTCHA_FAILED',
            message: 'The college ERP did not accept the captcha. Please try again.',
          },
        });
      }
      return res.status(e.status || 502).json({
        error: { code: e.code || 'LOGIN_FAILED', message: e.message || 'Could not log in to the college ERP.' },
      });
    }
  });

  /** Optional manual-captcha flow (bypasses OCR entirely — most reliable). */
  router.post('/captcha', async (req, res, next) => {
    try {
      const d = await erpCall('/v1/auth/captcha', {
        method: 'POST',
        body: { institute: req.body?.institute || 'MIPS' },
      });
      res.json(d);
    } catch (e) {
      next(e);
    }
  });

  router.post('/login-captcha', async (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const { sessionId, userId, password, captcha } = req.body || {};
    if (!userId || !password || !captcha) {
      return res.status(400).json({ error: { code: 'MISSING_CREDENTIALS', message: 'userId, password and captcha are required.' } });
    }
    if (rateLimited(ip)) {
      return res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Please wait.' } });
    }
    try {
      const data = await erpCall('/v1/auth/login', {
        method: 'POST',
        body: { sessionId, userId, password, captcha },
      });
      clearAttempts(ip);
      const token = mintToken(String(userId).trim(), data);
      return res.json({ token, user: data.user, role: data.role, expiresInSeconds: Math.floor(tokenTtlMs / 1000) });
    } catch (e) {
      if (e.code === 'INVALID_CAPTCHA') {
        // hand back a fresh image so the user can just retype
        return res.status(400).json({
          error: { code: 'INVALID_CAPTCHA', message: 'Wrong captcha. A new one has been generated.' },
          data: e.data,
        });
      }
      if (e.code === 'INVALID_CREDENTIALS' || e.code === 'INCORRECT_PASSWORD') {
        recordAttempt(ip);
        return res.status(401).json({
          error: {
            code: e.code,
            message: e.code === 'INCORRECT_PASSWORD' ? 'Incorrect password for this user ID.' : 'Incorrect user ID or password.',
            ...(e.data?.notice ? { notice: e.data.notice } : {}),
          },
        });
      }
      return res.status(e.status || 502).json({ error: { code: e.code || 'LOGIN_FAILED', message: e.message } });
    }
  });

  /** Auth guard. Binds the request to the token's own user only. */
  function requireToken(req, res, next) {
    const token =
      req.get('X-Session-Token') ||
      (req.get('Authorization') || '').replace(/^Bearer\s+/i, '') ||
      req.query.token;
    const s = token && sessions.get(String(token));
    if (!s) {
      return res.status(401).json({
        error: { code: 'NO_SESSION', message: 'Please log in again.' },
      });
    }
    if (Date.now() - s.lastUsed > tokenTtlMs) {
      sessions.delete(String(token));
      erpCall('/v1/auth/logout', { method: 'POST', apiKey: s.apiKey }).catch(() => {});
      return res.status(401).json({
        error: { code: 'SESSION_EXPIRED', message: 'Your session expired. Please enter your password again.' },
      });
    }
    s.lastUsed = Date.now();
    req.erp = s;
    next();
  }

  /** Who is this token? Lets the app confirm identity after a silent re-login. */
  router.get('/me', requireToken, (req, res) => {
    res.json({ user: req.erp.user, userId: req.erp.userId, loggedInAt: new Date(req.erp.createdAt).toISOString() });
  });

  /**
   * Generic passthrough: /api/erp/<path> → mips-erp-api /v1/<path>
   * New upstream endpoints work with no code change.
   */
  router.get(/^\/(.*)$/, requireToken, async (req, res, next) => {
    try {
      const path = '/' + req.params[0];
      const qs = req.originalUrl.split('?')[1];
      const data = await erpCall('/v1' + path + (qs ? '?' + qs : ''), { apiKey: req.erp.apiKey });
      res.json({ ok: true, data });
    } catch (e) {
      // map an expired/revoked upstream session to a clear re-login signal
      if (e.status === 401 || /BAD_API_KEY/i.test(e.code || '')) {
        return res.status(401).json({
          error: { code: 'SESSION_EXPIRED', message: 'Your college ERP session ended. Please enter your password again.' },
        });
      }
      next(e);
    }
  });

  router.post('/logout', requireToken, async (req, res) => {
    const token = req.get('X-Session-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    try {
      await erpCall('/v1/auth/logout', { method: 'POST', apiKey: req.erp.apiKey });
    } catch {
      /* best effort */
    }
    sessions.delete(String(token));
    res.json({ ok: true });
  });

  // housekeeping
  const gc = setInterval(() => {
    const now = Date.now();
    for (const [t, s] of sessions) if (now - s.lastUsed > tokenTtlMs) sessions.delete(t);
    for (const [ip, r] of attempts) if (now > r.reset) attempts.delete(ip);
  }, 60_000);
  if (gc.unref) gc.unref();

  // expose for diagnostics/tests
  router.locals = { sessions, attempts };
  return router;
}
