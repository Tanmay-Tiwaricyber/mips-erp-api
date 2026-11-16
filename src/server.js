/**
 * mips-erp-api — REST API over the MPGI/MIPS Asteroid365 student portal.
 *
 *   npm install && npm start      → http://localhost:3000
 *   API docs                      → http://localhost:3000/  (interactive)
 *
 * Auth model (multi-user): every caller has their own ERP session.
 *   1. POST /v1/auth/captcha            -> { sessionId, image (base64), ocr }
 *   2. POST /v1/auth/login              -> { apiKey }        (solve captcha yourself)
 *   or POST /v1/auth/login?auto=true    -> { apiKey }        (server OCR + safe retries)
 *
 * Then call any data endpoint with either:
 *   Authorization: Bearer <apiKey>       (recommended)
 *   X-ERP-Session: <sessionId>           (stateless step-by-step mode)
 */
import express from 'express';
import crypto from 'node:crypto';

import { Session, INSTITUTES, ErpError, BASE } from './session.js';
import { solveCaptcha, ocrAvailable, shutdownOcr } from './captcha.js';
import {
  parseSubjects,
  parseTimetable,
  parseAssessment,
  parseNotices,
  parseCalendar,
  parseClassmates,
  parseLoginHistory,
  normaliseProfile,
  parseGrid,
  htmlToText,
  parseAttendanceCounts,
  parseSubjectIds,
  parseMonthFilter,
  MONTH_NAMES,
} from './parsers.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 25 * 60 * 1000); // 25 min idle
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 200);
const OCR_RETRIES = Number(process.env.OCR_RETRIES || 15);

// ---------------------------------------------------------------- session store
/** apiKey -> { session, createdAt } ; sessionId -> Session (pre-login, captcha stage) */
const sessions = new Map();
const pending = new Map();

function gc() {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.session.lastUsed > SESSION_TTL_MS) sessions.delete(k);
  for (const [k, v] of pending) if (now - v.lastUsed > SESSION_TTL_MS) pending.delete(k);
}
setInterval(gc, 60 * 1000).unref();

function evictIfNeeded() {
  while (sessions.size >= MAX_SESSIONS) {
    // evict least-recently-used
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of sessions) {
      if (v.session.lastUsed < oldest) {
        oldest = v.session.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    sessions.delete(oldestKey);
  }
}

// ---------------------------------------------------------------- middleware
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.disable('x-powered-by');

// CORS: allow browser frontends on other origins to use the API.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-ERP-Session');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// tiny fixed-window rate limiter (per API key / IP)
const hits = new Map();
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 120);
const RATE_WINDOW = 60 * 1000;
app.use((req, res, next) => {
  const id = req.headers.authorization || req.ip;
  const now = Date.now();
  const rec = hits.get(id) || { count: 0, reset: now + RATE_WINDOW };
  if (now > rec.reset) {
    rec.count = 0;
    rec.reset = now + RATE_WINDOW;
  }
  rec.count += 1;
  hits.set(id, rec);
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT - rec.count));
  if (rec.count > RATE_LIMIT) {
    return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down.' } });
  }
  next();
});

/** Resolve the ERP session for this request. */
function resolveSession(req) {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (bearer) {
    const rec = sessions.get(bearer);
    if (!rec) throw new ErpError('Invalid or expired API key. Call POST /v1/auth/login again.', { status: 401, code: 'BAD_API_KEY' });
    rec.session.touch();
    return rec.session;
  }
  const sid = req.headers['x-erp-session'] || req.query.sessionId;
  if (sid) {
    const rec = pending.get(String(sid)) || sessions.get(String(sid));
    const s = rec?.session || rec;
    if (!s) throw new ErpError('Unknown sessionId.', { status: 401, code: 'BAD_SESSION' });
    s.touch();
    return s;
  }
  throw new ErpError('Missing credentials. Send "Authorization: Bearer <apiKey>" or "X-ERP-Session: <sessionId>".', {
    status: 401,
    code: 'NO_AUTH',
  });
}

/** Wrap a handler: resolves session, catches ErpError. */
const authed = (fn) => async (req, res, next) => {
  try {
    const session = resolveSession(req);
    const data = await fn(req, session);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------- meta

app.get('/', (req, res) => res.type('html').send(docsPage()));

app.get('/healthz', (req, res) => res.json({ ok: true, upstream: BASE, uptime: process.uptime() }));

app.get('/v1/institutes', (req, res) =>
  res.json({ ok: true, data: Object.entries(INSTITUTES).map(([key, v]) => ({ key, ...v })) })
);

app.get('/v1/capabilities', async (req, res) => {
  res.json({
    ok: true,
    data: {
      upstream: BASE,
      ocrAvailable: await ocrAvailable(),
      activeSessions: sessions.size,
      pendingCaptchas: pending.size,
      endpoints: ROUTES.map((r) => ({ method: r.method, path: r.path, description: r.description })),
    },
  });
});

// ---------------------------------------------------------------- auth

/** Step 1: get a captcha bound to a fresh session. */
app.post('/v1/auth/captcha', async (req, res, next) => {
  try {
    const institute = req.body?.institute || req.query.institute || 'MIPS';
    const session = new Session({ institute });
    await session.openLogin();
    const cap = await session.fetchCaptcha();

    const sessionId = crypto.randomUUID();
    pending.set(sessionId, { session, lastUsed: Date.now() });

    // opportunistic OCR so clients that can't show an image still have a shot
    let ocr = null;
    if (await ocrAvailable()) {
      const solved = await solveCaptcha(cap.image);
      ocr = solved.text;
    }

    res.json({
      ok: true,
      data: {
        sessionId,
        institute: session.instituteName,
        captchaImage: `data:${cap.mime};base64,${cap.image.toString('base64')}`,
        ocrGuess: ocr,
        next: { method: 'POST', path: '/v1/auth/login', body: { sessionId, userId: '<your id>', password: '<your pass>', captcha: '<6 chars>' } },
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Step 2: log in.
 *  - body { sessionId, userId, password, captcha }   → manual captcha
 *  - ?auto=true (or captcha omitted)                 → server OCR + retries
 *  - body { userId, password } without sessionId     → one-shot auto login
 * On success returns { apiKey } to use for every data call.
 */
app.post('/v1/auth/login', async (req, res, next) => {
  const { sessionId, userId, password, captcha, institute = 'MIPS' } = req.body || {};
  const auto = req.query.auto === 'true' || req.body?.auto === true || captcha === undefined;

  if (!userId || !password) {
    return next(new ErpError('userId and password are required', { status: 400, code: 'MISSING_CREDENTIALS' }));
  }

  try {
    let session;
    if (sessionId) {
      const rec = pending.get(String(sessionId));
      if (!rec) return next(new ErpError('Unknown or expired sessionId. Call /v1/auth/captcha first.', { status: 400, code: 'BAD_SESSION' }));
      session = rec.session;
      pending.delete(String(sessionId));
    } else {
      session = new Session({ institute });
      await session.openLogin();
      await session.fetchCaptcha();
    }

    // --- manual path: exactly one attempt with the caller's captcha
    if (!auto) {
      const result = await session.login(userId, password, String(captcha || '').trim());
      if (!result.ok) {
        if (result.retryable) {
          // give them a fresh captcha on the same session
          const cap = await session.fetchCaptcha();
          const sid = sessionId || crypto.randomUUID();
          pending.set(sid, { session, lastUsed: Date.now() });
          return res.status(400).json({
            ok: false,
            error: { code: 'INVALID_CAPTCHA', message: 'Captcha was wrong. A fresh captcha was generated — retry with the new one.' },
            data: { sessionId: sid, captchaImage: `data:${cap.mime};base64,${cap.image.toString('base64')}` },
          });
        }
        const bad = result.label === 'INVALID_CREDENTIALS' || result.label === 'INCORRECT_PASSWORD';
        return res.status(401).json({
          ok: false,
          error: {
            code: result.label,
            message: bad ? 'Incorrect user ID or password.' : result.message || 'Login failed',
            ...(result.credentialsEmailed
              ? { notice: 'The college ERP has e-mailed the registered address with the current credentials.' }
              : {}),
            attempts: result.invalidLoginAttempt,
          },
        });
      }
      return issueKey(res, session, { captchaAttempts: 1, solvedBy: 'client' });
    }

    // --- auto path: OCR + retry (only captcha failures are retried, they don't count as attempts)
    if (!(await ocrAvailable())) {
      const cap = await session.fetchCaptcha();
      const sid = sessionId || crypto.randomUUID();
      pending.set(sid, { session, lastUsed: Date.now() });
      return res.status(409).json({
        ok: false,
        error: {
          code: 'OCR_UNAVAILABLE',
          message: 'Auto mode needs the optional OCR deps (sharp + tesseract.js). Install them, or solve the captcha manually.',
        },
        data: { sessionId: sid, captchaImage: `data:${cap.mime};base64,${cap.image.toString('base64')}` },
      });
    }

    let attempts = 0;
    const tried = new Set();
    while (attempts < OCR_RETRIES) {
      attempts++;
      const solved = await solveCaptcha(session.captcha?.image ?? (await session.fetchCaptcha()).image);
      if (!solved.text || tried.has(solved.text)) {
        await session.fetchCaptcha();
        continue;
      }
      tried.add(solved.text);
      const result = await session.login(userId, password, solved.text);
      if (result.ok) return issueKey(res, session, { captchaAttempts: attempts, solvedBy: 'ocr' });
      if (!result.retryable) {
        // INCORRECT_PASSWORD / INVALID_CREDENTIALS are NOT retried: each attempt
        // makes the ERP re-send the student's credential e-mail and counts toward
        // its lockout. Fail fast, with a sanitised message.
        const bad = result.label === 'INVALID_CREDENTIALS' || result.label === 'INCORRECT_PASSWORD';
        return res.status(401).json({
          ok: false,
          error: {
            code: bad ? result.label : result.label,
            message: bad ? 'Incorrect user ID or password.' : result.message || 'Login failed',
            ...(result.credentialsEmailed
              ? { notice: 'The college ERP has e-mailed the registered address with the current credentials. Check that inbox.' }
              : {}),
            hint: bad ? 'Check the user id and password.' : undefined,
          },
        });
      }
      await session.fetchCaptcha(); // fresh captcha for the next try
    }

    const cap = await session.fetchCaptcha();
    const sid = crypto.randomUUID();
    pending.set(sid, { session, lastUsed: Date.now() });
    return res.status(429).json({
      ok: false,
      error: {
        code: 'CAPTCHA_OCR_FAILED',
        message: `OCR could not read the captcha in ${attempts} attempts (it is only ~33% accurate per attempt). Solve it manually.`,
        attempts,
      },
      data: { sessionId: sid, captchaImage: `data:${cap.mime};base64,${cap.image.toString('base64')}` },
    });
  } catch (err) {
    next(err);
  }
});

function issueKey(res, session, meta = {}) {
  evictIfNeeded();
  const apiKey = `erp_${crypto.randomBytes(24).toString('base64url')}`;
  sessions.set(apiKey, { session, createdAt: Date.now() });
  res.json({
    ok: true,
    data: {
      apiKey,
      user: session.user,
      role: session.role,
      institute: session.instituteName,
      expiresInSeconds: Math.round(SESSION_TTL_MS / 1000),
      ...meta,
    },
  });
}

app.post('/v1/auth/logout', authed(async (req, session) => {
  try {
    await session.ajax('json/json_service.asmx/logout_Usr', {});
  } catch {
    /* best effort */
  }
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  sessions.delete(auth);
  return { loggedOut: true };
}));

app.get('/v1/auth/me', authed(async (req, session) => ({
  user: session.user,
  role: session.role,
  institute: session.instituteName,
  authenticated: session.authenticated,
})));

// ---------------------------------------------------------------- student data

app.get('/v1/student/profile', authed(async (req, session) => {
  const rec = await session.ajax('home.aspx/getStuDashboard_Details', {});
  const row = Array.isArray(rec) ? rec[0] : rec;
  return normaliseProfile(row || {});
}));

app.get('/v1/student/subjects', authed(async (req, session) => {
  const html = await session.ajax('home.aspx/getMySubjects', {});
  return parseSubjects(html);
}));

app.get('/v1/student/timetable', authed(async (req, session) => {
  // The portal passes the server timestamp; any valid date string works.
  // The portal passes its own server timestamp; reuse the one captured at login.
  if (!session.serverDateTime) await session.primeDashboard();
  const asOf =
    req.query.date ||
    session.serverDateTime ||
    new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });
  const res = await session.ajax('json/TimeTableWS.asmx/StudentTimeTableWithAttendance', {
    student: session.user.registrationCode,
    attendanceDate: asOf,
    withAttendanceStatus: 1,
  });
  // The grid always covers the whole week; the ERP marks per-period attendance
  // only on the row matching `asOf`. Both are returned.
  return { asOf, ...parseTimetable(res?.timeTable_ViewString_P) };
}));

app.get('/v1/student/attendance', authed(async (req, session) => {
  // Per-subject percentages come from the assessment grid. The real
  // present/absent/lecture triple has to come from the attendance report, which
  // needs the student's internal ids — passing -1 (what this route used to do)
  // silently returns 0,0,0 and left `present`/`absent`/`totalLectures` dead.
  const ctx = req.query.sid && req.query.sid !== '-1'
    ? {
        sid: String(req.query.sid),
        prg: String(req.query.prg ?? '-1'),
        branch: String(req.query.branch ?? '-1'),
        ys: String(req.query.ys ?? '-1'),
      }
    : await attendanceContext(session);

  const month = parseMonthFilter(req.query.month);
  if (month === null) {
    throw new ErpError(`Unknown month "${req.query.month}"`, { status: 400, code: 'BAD_MONTH' });
  }

  const [counts, summaryHtml] = await Promise.all([
    attendanceSlice(session, ctx, req.query.subject || 0, month),
    session.ajax('examResult.aspx/getStu_ExamSummary', { roll: session.user.registrationCode }),
  ]);
  const { subjects, totals } = parseAssessment(summaryHtml);

  const present = counts.present ?? 0;
  const absent = counts.absent ?? 0;
  const total = counts.total ?? 0;

  // Fall back to the aggregate the ERP prints on the assessment grid footer
  // ("72 %") only when the report has nothing for this slice.
  const gridPercent = totals?.attendancePercent ? parseFloat(String(totals.attendancePercent)) : null;
  const rawPercent = total ? +((present / total) * 100).toFixed(2) : null;

  return {
    overall: {
      percent: rawPercent ?? (Number.isFinite(gridPercent) ? gridPercent : null),
      present,
      absent,
      totalLectures: total,
      source: rawPercent !== null ? 'attendance-report' : Number.isFinite(gridPercent) ? 'assessment-grid' : null,
      month: month === 0 ? null : month,
    },
    bySubject: subjects.map((s) => {
      const p = parseFloat(s.attendance);
      return { name: s.name, code: s.code, percent: Number.isFinite(p) ? p : null, status: s.attendance };
    }),
    totals,
  };
}));

/**
 * Per-period attendance for one date.
 *
 *   GET /v1/student/attendance/daily?date=2026-11-14
 *
 * Returns each period of that day with attendance: "present" | "absent" | null
 * (null = not marked yet). This is the data behind the portal's
 * "Attendance: Present" / "Attendance Not Marked" labels.
 */
/**
 * One shape for daily attendance, used by the standalone route, the history
 * range and the /v1/dashboard panel — so a client never has to branch.
 *
 * `periods[]` holds real class slots only: empty grid holes are dropped and the
 * LUNCH marker is skipped, while `period` keeps the original grid position.
 * `attendance` is "present" | "absent" | null, where null means the teacher
 * hasn't marked that period yet (the portal renders nothing at all for those).
 */
function buildDailyAttendance(parsed, { date, weekday }) {
  const day = parsed.days.find((d) => d.day === weekday);
  const periods = (day?.periods || [])
    .map((p, i) => (p && p.type !== 'LUNCH' ? { period: i + 1, ...p } : null))
    .filter(Boolean);
  const ref = (p) => ({ subject: p.subject, code: p.code });
  return {
    date,
    weekday,
    // which row the ERP actually attached marks to (normally === weekday)
    markedDay: parsed.markedDay,
    summary: parsed.attendanceSummary,
    periods,
    present: periods.filter((p) => p.attendance === 'present').map(ref),
    absent: periods.filter((p) => p.attendance === 'absent').map(ref),
    notMarked: periods.filter((p) => p.attendance === null).map(ref),
  };
}

/**
 * The ids the attendance report needs. The portal reads them off hidden inputs
 * that are filled by getStuDashboard_Details — `sid` in particular is the
 * internal student id (e.g. 13349), not the registration code.
 */
async function attendanceContext(session) {
  const raw = await session.ajax('home.aspx/getStuDashboard_Details', {});
  const det = Array.isArray(raw) ? raw[0] : raw;
  if (!det || det.StudentId_P === undefined) {
    throw new ErpError('Could not read student ids from the portal dashboard', {
      status: 502,
      code: 'ERP_CALL_FAILED',
    });
  }
  return {
    sid: String(det.StudentId_P),
    prg: String(det.prgId_P),
    branch: String(det.branchId_P),
    ys: String(det.stuSem_P),
  };
}

/** One call to the report webmethod. Returns parsed counts, never raw text. */
async function attendanceSlice(session, ctx, subject, month) {
  const raw = await session.ajax('viewStuAttendance_rpt.aspx/getAttendance', {
    ...ctx,
    subject: String(subject ?? 0),
    month: String(month ?? 0),
  });
  return parseAttendanceCounts(raw);
}

/**
 * Cumulative + month-by-month attendance totals.
 *
 * This is the same pie chart the student dashboard draws ("Cumulative
 * Attendance") and the same numbers the report page's totals row shows.
 *
 *   GET /v1/student/attendance/summary
 *   GET /v1/student/attendance/summary?month=11
 */
app.get('/v1/student/attendance/summary', authed(async (req, session) => {
  const month = parseMonthFilter(req.query.month);
  if (month === null) {
    throw new ErpError(
      `Unknown month "${req.query.month}" — use 1-12, a month name, or "all"`,
      { status: 400, code: 'BAD_MONTH' }
    );
  }
  const ctx = await attendanceContext(session);

  if (month !== 0) {
    const slice = await attendanceSlice(session, ctx, 0, month);
    return {
      scope: 'month',
      month,
      monthName: MONTH_NAMES[month - 1],
      ...slice,
    };
  }

  // cumulative + every month that actually has lectures (1-12 probed in parallel)
  const monthResults = await Promise.all(
    MONTH_NAMES.map((name, i) => attendanceSlice(session, ctx, 0, i + 1))
  );
  const byMonth = monthResults.map((m, i) => ({
    month: i + 1,
    monthName: MONTH_NAMES[i],
    ...m,
  }));
  const cumulative = await attendanceSlice(session, ctx, 0, 0);

  return {
    scope: 'cumulative',
    ...cumulative,
    byMonth,
    monthsWithLectures: byMonth.filter((m) => m.total > 0).map((m) => m.monthName),
  };
}));

/**
 * Per-subject attendance totals, optionally for a single month.
 *
 *   GET /v1/student/attendance/by-subject
 *   GET /v1/student/attendance/by-subject?month=10
 *
 * Subjects with no marked lectures in the window are returned with total 0 and
 * percent null rather than being silently dropped — the student still has to see
 * "this lab hasn't been marked yet".
 */
app.get('/v1/student/attendance/by-subject', authed(async (req, session) => {
  const month = parseMonthFilter(req.query.month);
  if (month === null) {
    throw new ErpError(
      `Unknown month "${req.query.month}" — use 1-12, a month name, or "all"`,
      { status: 400, code: 'BAD_MONTH' }
    );
  }
  const [ctx, subjectsHtml] = await Promise.all([
    attendanceContext(session),
    session.ajax('home.aspx/getMySubjects', {}),
  ]);
  const idMap = parseSubjectIds(subjectsHtml);
  const subjects = [...idMap.values()];

  const rows = await Promise.all(
    subjects.map(async (sub) => {
      const counts = await attendanceSlice(session, ctx, sub.sd, month);
      return {
        name: sub.name,
        code: sub.code,
        type: sub.type,
        ...counts,
      };
    })
  );

  // running total across subjects, so a client can show a footer row
  const overall = rows.reduce(
    (acc, r) => ({
      present: acc.present + (r.present || 0),
      absent: acc.absent + (r.absent || 0),
      total: acc.total + (r.total || 0),
    }),
    { present: 0, absent: 0, total: 0 }
  );
  overall.percent = overall.total ? Math.round((overall.present * 100) / overall.total) : null;

  return {
    scope: month === 0 ? 'cumulative' : 'month',
    month,
    monthName: month === 0 ? null : MONTH_NAMES[month - 1],
    subjects: rows,
    overall,
    // Split theory vs labs. The portal's own "Subject Type" column labels even
    // lab subjects as "Theory", so classify on the name instead.
    byType: {
      lab: rows.filter((r) => /\b(lab|practical|workshop|drawing)\b/i.test(r.name || '')),
      theory: rows.filter((r) => !/\b(lab|practical|workshop|drawing)\b/i.test(r.name || '')),
    },
  };
}));

/**
 * Every attendance number the portal can show, in one request.
 *
 *   GET /v1/student/attendance/complete
 *
 * Combines: the dashboard pie (cumulative), the month breakdown, the per-subject
 * grid for the current month and cumulatively, and today's per-period marks. All
 * of it is read-only report data — the ERP has no endpoint that lists individual
 * dated lecture records for a student, so this is the widest view it exposes.
 */
app.get('/v1/student/attendance/complete', authed(async (req, session) => {
  const [ctx, subjectsHtml] = await Promise.all([
    attendanceContext(session),
    session.ajax('home.aspx/getMySubjects', {}),
  ]);
  const idMap = parseSubjectIds(subjectsHtml);
  const subjects = [...idMap.values()];

  const safe = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return { error: e.message };
    }
  };

  const [cumulative, byMonth, perSubjectCumulative] = await Promise.all([
    safe(() => attendanceSlice(session, ctx, 0, 0)),
    safe(() =>
      Promise.all(MONTH_NAMES.map((name, i) => attendanceSlice(session, ctx, 0, i + 1)))
        .then((rows) => rows.map((r, i) => ({ month: i + 1, monthName: MONTH_NAMES[i], ...r })))
    ),
    safe(() =>
      Promise.all(
        subjects.map(async (sub) => ({ name: sub.name, code: sub.code, type: sub.type, ...(await attendanceSlice(session, ctx, sub.sd, 0)) }))
      )
    ),
  ]);

  return {
    cumulative,
    byMonth,
    monthsWithLectures: Array.isArray(byMonth)
      ? byMonth.filter((m) => m.total > 0).map((m) => m.monthName)
      : [],
    bySubject: perSubjectCumulative,
  };
}));

app.get('/v1/student/attendance/daily', authed(async (req, session) => {
  if (!session.serverDateTime) await session.primeDashboard();
  // No ?date= means "the day the portal considers today" — the ERP runs on IST,
  // so trust its serverDateTime rather than the container clock.
  const date = req.query.date
    ? normaliseDate(req.query.date)
    : formatErpDate(parseErpDate(session.serverDateTime) || new Date());

  const res = await session.ajax('json/TimeTableWS.asmx/StudentTimeTableWithAttendance', {
    student: session.user.registrationCode,
    attendanceDate: date,
    withAttendanceStatus: 1,
  });

  const requestedDay = WEEKDAYS[parseErpDate(date).getDay()];
  const parsed = parseTimetable(res?.timeTable_ViewString_P, requestedDay);
  return buildDailyAttendance(parsed, { date, weekday: requestedDay });
}));

/**
 * Daily attendance history over a date range.
 *
 *   GET /v1/student/attendance/daily/history?from=2026-11-08&to=2026-11-14
 *
 * The ERP marks attendance one date at a time, so this makes one upstream call
 * per date (bounded to 31, run with limited concurrency). Dates in the future
 * and Sundays are skipped. Per-subject totals are aggregated across the range.
 */
app.get('/v1/student/attendance/daily/history', authed(async (req, session) => {
  // `to` defaults to today, `from` defaults to 7 days back (never future dates).
  const endDate = parseErpDate(req.query.to || req.query.date) || new Date();
  const startDate = parseErpDate(req.query.from) || new Date(endDate.getTime() - 6 * 86400000);
  const to = formatErpDate(endDate);
  const from = formatErpDate(startDate);
  const start = startDate;
  const end = endDate;
  if (!start || !end) throw new ErpError('Invalid from/to date', { status: 400, code: 'BAD_DATE' });
  if (start > end) throw new ErpError('"from" must be before "to"', { status: 400, code: 'BAD_RANGE' });

  const spanDays = Math.round((end - start) / 86400000) + 1;
  if (spanDays > 31) {
    throw new ErpError('Range too large — max 31 days per request', { status: 400, code: 'RANGE_TOO_LARGE' });
  }
  if (!session.serverDateTime) await session.primeDashboard();

  const dates = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day === 0) continue; // Sunday — no classes
    dates.push(formatErpDate(d));
  }

  const days = [];
  const perSubject = new Map();
  const CONCURRENCY = 3;

  for (let i = 0; i < dates.length; i += CONCURRENCY) {
    const batch = dates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (date) => {
        try {
          const res = await session.ajax('json/TimeTableWS.asmx/StudentTimeTableWithAttendance', {
            student: session.user.registrationCode,
            attendanceDate: date,
            withAttendanceStatus: 1,
          });
          const requestedDay = WEEKDAYS[parseErpDate(date).getDay()];
          const parsed = parseTimetable(res?.timeTable_ViewString_P, requestedDay);
          const day = parsed.days.find((d) => d.day === requestedDay);
          const periods = (day?.periods || []).filter((p) => p && p.type !== 'LUNCH');
          return { date, weekday: requestedDay, periods, summary: parsed.attendanceSummary };
        } catch (e) {
          return { date, error: e.message };
        }
      })
    );
    for (const r of results) {
      if (r.error) {
        days.push({ date: r.date, error: r.error });
        continue;
      }
      days.push({
        date: r.date,
        weekday: r.weekday,
        summary: r.summary,
        periods: r.periods.map((p) => ({
          subject: p.subject, code: p.code, teacher: p.teacher,
          kind: p.kind, attendance: p.attendance, attendanceLabel: p.attendanceLabel,
        })),
      });
      days[days.length - 1].present = r.periods.filter((p) => p.attendance === 'present').map((p) => ({ subject: p.subject, code: p.code }));
      days[days.length - 1].absent = r.periods.filter((p) => p.attendance === 'absent').map((p) => ({ subject: p.subject, code: p.code }));
      days[days.length - 1].notMarked = r.periods.filter((p) => p.attendance === null).map((p) => ({ subject: p.subject, code: p.code }));
      for (const p of r.periods) {
        if (!p.attendance) continue;
        const key = p.code || p.subject;
        const agg = perSubject.get(key) || { subject: p.subject, code: p.code, present: 0, absent: 0 };
        if (p.attendance === 'present') agg.present += 1;
        else if (p.attendance === 'absent') agg.absent += 1;
        perSubject.set(key, agg);
      }
    }
  }

  const totals = { present: 0, absent: 0 };
  for (const a of perSubject.values()) {
    totals.present += a.present;
    totals.absent += a.absent;
  }
  const marked = totals.present + totals.absent;

  return {
    from,
    to,
    daysReturned: days.length,
    totals: {
      ...totals,
      marked,
      percent: marked ? +((totals.present / marked) * 100).toFixed(1) : null,
    },
    bySubject: [...perSubject.values()]
      .map((a) => ({
        ...a,
        marked: a.present + a.absent,
        percent: a.present + a.absent ? +((a.present / (a.present + a.absent)) * 100).toFixed(1) : null,
      }))
      .sort((x, y) => x.subject.localeCompare(y.subject)),
    days,
  };
}));

app.get('/v1/student/assessment', authed(async (req, session) => {
  const html = await session.ajax('examResult.aspx/getStu_ExamSummary', { roll: session.user.registrationCode });
  return parseAssessment(html);
}));

app.get('/v1/notices', authed(async (req, session) => {
  const now = new Date();
  const list = await session.ajax('home.aspx/btnSearch_NoticeCirculars', {
    title: String(req.query.q || ''),
    month: String(req.query.month || now.getMonth() + 1),
    year: String(req.query.year || now.getFullYear()),
    category: String(req.query.category || 0),
    cFor: 'S',
  });
  const notices = parseNotices(list);
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  return { count: notices.length, notices: notices.slice(0, limit) };
}));

app.get('/v1/calendar/holidays', authed(async (req, session) => {
  const html = await session.ajax('json/controlBindService.asmx/getAcademicCalendarItems', {
    calendarId: String(req.query.calendarId || 7),
  });
  return parseCalendar(html);
}));

app.get('/v1/calendar/lists', authed(async (req, session) => {
  const html = await session.ajax('json/controlBindService.asmx/bindAcademic_Calendar', {});
  const $opts = [...String(html || '').matchAll(/<option value='?(\d+)'?>([^<]+)<\/option>/g)].map((m) => ({
    id: Number(m[1]),
    name: m[2].trim(),
  }));
  return $opts.filter((o) => o.id !== 0);
}));

app.get('/v1/student/classmates', authed(async (req, session) => {
  const html = await session.ajax('home.aspx/getClassMates', {});
  return parseClassmates(html);
}));

app.get('/v1/student/documents', authed(async (req, session) => {
  const list = await session.ajax('ImportantDocuments.aspx/GetSpecificDocumentLinks', { documentFor: 'S' });
  return (list || []).map((d) => ({ title: d.Title, description: d.LinkDescription, url: d.ReferenceLink }));
}));

app.get('/v1/student/coordinators', authed(async (req, session) => {
  const html = await session.ajax('classCoordinators.aspx/getClassCoordinators_Stu', {});
  return { html, text: htmlToText(html) };
}));

app.get('/v1/student/no-dues', authed(async (req, session) => {
  const html = await session.ajax('checkStudDues.aspx/getNoDues_Stu', {});
  return { rows: parseGrid(html), text: htmlToText(html) };
}));

app.get('/v1/student/todo', authed(async (req, session) => {
  const html = await session.ajax('home.aspx/getStuToDoList', {});
  return { rows: parseGrid(html), text: htmlToText(html) };
}));

app.get('/v1/student/assignments', authed(async (req, session) => {
  const html = await session.ajax('home.aspx/getAssignmentBar_ForStudents', {});
  return { text: htmlToText(html), html };
}));

app.get('/v1/student/feedback', authed(async (req, session) => {
  const html = await session.ajax('Home.aspx/getAvailableFeedback_Links', {});
  const links = [...String(html || '').matchAll(/href='([^']+)'[^>]*title='([^']*)'/g)].map((m) => ({
    title: m[2],
    url: m[1],
  }));
  return { links, text: htmlToText(html) };
}));

app.get('/v1/account/login-history', authed(async (req, session) => {
  const d = await session.ajax('Home.aspx/getLog_History', {});
  return parseLoginHistory(d?.field_P || '');
}));

app.get('/v1/account/leave-balance', authed(async (req, session) =>
  session.ajax('Json/LeaveManagement.asmx/getMyLeaveBalance', {})
));

/**
 * Everything in one call — handy for a dashboard first paint.
 * Runs the individual panels in parallel; failures are reported per-panel
 * rather than failing the whole request.
 */
app.get('/v1/dashboard', authed(async (req, session) => {
  const safe = async (fn) => {
    try {
      return { ok: true, data: await fn() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  const today = req.query.date || null;
  const [profile, subjects, assessment, notices, holidays, classmates, documents, history, todayAttendance] = await Promise.all([
    safe(async () => normaliseProfile((await session.ajax('home.aspx/getStuDashboard_Details', {}))[0])),
    safe(async () => parseSubjects(await session.ajax('home.aspx/getMySubjects', {}))),
    safe(async () => parseAssessment(await session.ajax('examResult.aspx/getStu_ExamSummary', { roll: session.user.registrationCode }))),
    safe(async () => {
      const n = new Date();
      return parseNotices(
        await session.ajax('home.aspx/btnSearch_NoticeCirculars', {
          title: '', month: String(n.getMonth() + 1), year: String(n.getFullYear()), category: '0', cFor: 'S',
        })
      ).slice(0, 20);
    }),
    safe(async () => parseCalendar(await session.ajax('json/controlBindService.asmx/getAcademicCalendarItems', { calendarId: '7' }))),
    safe(async () => parseClassmates(await session.ajax('home.aspx/getClassMates', {}))),
    safe(async () => {
      const l = await session.ajax('ImportantDocuments.aspx/GetSpecificDocumentLinks', { documentFor: 'S' });
      return (l || []).map((d) => ({ title: d.Title, url: d.ReferenceLink }));
    }),
    safe(async () => parseLoginHistory((await session.ajax('Home.aspx/getLog_History', {}))?.field_P || '')),
    safe(async () => {
      const date = normaliseDate(today || formatErpDate(parseErpDate(session.serverDateTime) || new Date()));
      const weekday = WEEKDAYS[parseErpDate(date).getDay()];
      const res = await session.ajax('json/TimeTableWS.asmx/StudentTimeTableWithAttendance', {
        student: session.user.registrationCode,
        attendanceDate: date,
        withAttendanceStatus: 1,
      });
      const parsed = parseTimetable(res?.timeTable_ViewString_P, weekday);
      return buildDailyAttendance(parsed, { date, weekday });
    }),
  ]);
  return { profile, subjects, assessment, notices, holidays, classmates, documents, loginHistory: history, todayAttendance };
}));

/** Escape hatch: call any upstream ASP.NET webmethod yourself. */
app.post('/v1/raw', authed(async (req, session) => {
  const { path, payload = {} } = req.body || {};
  if (!path || typeof path !== 'string') {
    throw new ErpError('body.path is required, e.g. "home.aspx/getMySubjects"', { status: 400, code: 'MISSING_PATH' });
  }
  if (!/^[\w./-]+\.(aspx|asmx)\/[\w]+$/.test(path)) {
    throw new ErpError('path must look like "page.aspx/Method"', { status: 400, code: 'BAD_PATH' });
  }
  const d = await session.ajax(path, payload);
  return { path, result: d, text: typeof d === 'string' ? htmlToText(d) : undefined };
}));

// ---------------------------------------------------------------- errors & docs

app.use((req, res) => res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.path}` } }));

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err.code || err.name, err.message);
  res.status(status).json({
    ok: false,
    error: {
      code: err.code || 'INTERNAL',
      message: err.message || 'Unexpected error',
      ...(err.upstream ? { upstream: err.upstream } : {}),
    },
  });
});

// ---------------------------------------------------------------- date helpers

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Accepts 2026-11-14, 14-Nov-2026, 14/11/2026 or a Date; returns "DD-Mon-YYYY". */
function normaliseDate(input) {
  const d = parseErpDate(input);
  if (!d) throw new ErpError(`Invalid date "${input}" — use YYYY-MM-DD or DD-Mon-YYYY`, { status: 400, code: 'BAD_DATE' });
  return formatErpDate(d);
}

function parseErpDate(input) {
  if (!input) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  const s = String(input).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); // 2026-11-14
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ](\d{4})/); // 14-Nov-2026
  if (m) {
    const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (mi >= 0) return new Date(Number(m[3]), mi, Number(m[1]));
  }
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/); // 14/11/2026
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatErpDate(d) {
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

const ROUTES = [
  { method: 'GET', path: '/healthz', description: 'Liveness probe' },
  { method: 'GET', path: '/v1/institutes', description: 'Known institute keys + ids' },
  { method: 'GET', path: '/v1/capabilities', description: 'Feature/OCR status + route list' },
  { method: 'POST', path: '/v1/auth/captcha', description: 'Step 1 — start session, return captcha image' },
  { method: 'POST', path: '/v1/auth/login', description: 'Step 2 — login (manual captcha or ?auto=true) → apiKey' },
  { method: 'POST', path: '/v1/auth/logout', description: 'Log out and drop the session' },
  { method: 'GET', path: '/v1/auth/me', description: 'Current session identity' },
  { method: 'GET', path: '/v1/dashboard', description: 'All dashboard panels in one parallel call' },
  { method: 'GET', path: '/v1/student/profile', description: 'Student record (program, branch, semester…)' },
  { method: 'GET', path: '/v1/student/subjects', description: 'Registered subjects + syllabus links' },
  { method: 'GET', path: '/v1/student/timetable', description: 'Weekly timetable w/ teachers' },
  { method: 'GET', path: '/v1/student/attendance', description: 'Attendance overall + per subject' },
  { method: 'GET', path: '/v1/student/attendance/summary', description: 'Cumulative attendance + month-by-month breakdown' },
  { method: 'GET', path: '/v1/student/attendance/by-subject', description: 'Per-subject totals, optional month, theory vs lab' },
  { method: 'GET', path: '/v1/student/attendance/complete', description: 'Every attendance view in one call' },
  { method: 'GET', path: '/v1/student/attendance/daily', description: 'Per-period attendance for one date (present/absent/not marked)' },
  { method: 'GET', path: '/v1/student/attendance/daily/history', description: 'Daily attendance over a date range + per-subject totals' },
  { method: 'GET', path: '/v1/student/assessment', description: 'Mid-sem / unit test / assignment marks' },
  { method: 'GET', path: '/v1/student/classmates', description: 'Class list' },
  { method: 'GET', path: '/v1/student/documents', description: 'Important document links' },
  { method: 'GET', path: '/v1/student/coordinators', description: 'Class coordinators' },
  { method: 'GET', path: '/v1/student/no-dues', description: 'No-dues status' },
  { method: 'GET', path: '/v1/student/todo', description: 'To-do list' },
  { method: 'GET', path: '/v1/student/assignments', description: 'Assignment bar / count' },
  { method: 'GET', path: '/v1/student/feedback', description: 'Open feedback forms' },
  { method: 'GET', path: '/v1/notices', description: 'Circulars & notices (filters: q, month, year, category)' },
  { method: 'GET', path: '/v1/calendar/holidays', description: 'Academic calendar / holiday list' },
  { method: 'GET', path: '/v1/calendar/lists', description: 'Available calendar lists' },
  { method: 'GET', path: '/v1/account/login-history', description: 'Recent logins (date + IP)' },
  { method: 'GET', path: '/v1/account/leave-balance', description: 'Leave balances' },
  { method: 'POST', path: '/v1/raw', description: 'Escape hatch — call any upstream webmethod' },
];

function docsPage() {
  const rows = ROUTES.map(
    (r) =>
      `<tr><td><span class="m ${r.method}">${r.method}</span></td><td><code>${r.path}</code></td><td>${r.description}</td></tr>`
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>mips-erp-api</title>
<style>
body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#0f172a}
h1{font-size:26px;letter-spacing:-.02em;margin-bottom:4px}
p.sub{color:#64748b;margin-top:0}
code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:12.5px}
table{width:100%;border-collapse:collapse;margin:18px 0}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b}
.m{font-size:10px;font-weight:800;padding:2px 6px;border-radius:4px;color:#fff}
.GET{background:#0e7490}.POST{background:#7c3aed}
pre{background:#0f172a;color:#e2e8f0;padding:14px 16px;border-radius:10px;overflow:auto;font-size:12.5px}
</style></head><body>
<h1>mips-erp-api</h1>
<p class="sub">REST wrapper over <code>${BASE}</code> — Asteroid365 student portal.</p>
<h3>Quick start</h3>
<pre># 1) auto login (server solves the captcha, retries safely)
curl -X POST localhost:${PORT}/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"userId":"2026BT0683","password":"***","institute":"MIPS"}'

# 2) use the apiKey
curl localhost:${PORT}/v1/dashboard -H 'Authorization: Bearer erp_...'</pre>
<h3>Endpoints</h3>
<table><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

// ---------------------------------------------------------------- boot
const server = app.listen(PORT, HOST, async () => {
  const ocr = await ocrAvailable();
  console.log(`mips-erp-api listening on http://${HOST}:${PORT}`);
  console.log(`  upstream : ${BASE}`);
  console.log(`  OCR      : ${ocr ? 'available' : 'NOT installed (manual captcha only)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n${sig} — shutting down`);
    server.close();
    await shutdownOcr();
    process.exit(0);
  });
}
