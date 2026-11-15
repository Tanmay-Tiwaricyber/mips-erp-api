#!/usr/bin/env node
/**
 * End-to-end smoke test — hits the running API with real credentials.
 *
 *   API_URL=http://localhost:3000 ERP_USER=2026BT0683 ERP_PASS='...' node examples/smoke.mjs
 *
 * Useful as a deploy check (Vercel/Render/Docker): it logs in, then walks every
 * data endpoint and asserts the shapes your ERP project will consume.
 */
const API = process.env.API_URL || 'http://localhost:3000';
const USER = process.env.ERP_USER;
const PASS = process.env.ERP_PASS;
const INSTITUTE = process.env.ERP_INSTITUTE || 'MIPS';

if (!USER || !PASS) {
  console.error('Set ERP_USER and ERP_PASS (and optionally ERP_INSTITUTE, API_URL).');
  process.exit(2);
}

let failures = 0;
const log = (ok, label, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✔' : '✘'} ${label}${extra ? ' — ' + extra : ''}`);
};

async function call(path, opts = {}) {
  const res = await fetch(API + path, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, body };
}

console.log(`\n▸ health`);
let r = await call('/healthz');
log(r.status === 200 && r.body?.ok === true, 'GET /healthz', JSON.stringify(r.body));

console.log(`\n▸ auth (auto: server solves the captcha)`);
const t0 = Date.now();
r = await call('/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: USER, password: PASS, institute: INSTITUTE }),
});
const loginMs = Date.now() - t0;
const key = r.body?.data?.apiKey;
log(r.status === 200 && !!key, 'POST /v1/auth/login', `${loginMs}ms, captcha attempts=${r.body?.data?.captchaAttempts ?? '?'}, solvedBy=${r.body?.data?.solvedBy ?? '?'}`);
if (!key) {
  console.log('\nLogin failed:', JSON.stringify(r.body, null, 2));
  process.exit(1);
}

const auth = { Authorization: `Bearer ${key}` };

const checks = [
  ['/v1/auth/me', (d) => d.user?.userId === USER.toUpperCase() || !!d.user?.userId],
  ['/v1/student/profile', (d) => !!d.registrationCode],
  ['/v1/student/subjects', (d) => Array.isArray(d) && d.length > 0],
  ['/v1/student/timetable', (d) => Array.isArray(d.days) && d.days.length > 0],
  ['/v1/student/attendance', (d) => Array.isArray(d.bySubject)],
  ['/v1/student/assessment', (d) => Array.isArray(d.subjects)],
  ['/v1/notices?limit=5', (d) => Array.isArray(d.notices) && d.notices.length > 0],
  ['/v1/calendar/holidays', (d) => Array.isArray(d)],
  ['/v1/student/classmates', (d) => Array.isArray(d)],
  ['/v1/student/documents', (d) => Array.isArray(d)],
  ['/v1/student/no-dues', (d) => Array.isArray(d.rows)],
  ['/v1/student/todo', (d) => Array.isArray(d.rows)],
  ['/v1/student/assignments', (d) => typeof d.text === 'string'],
  ['/v1/student/feedback', (d) => Array.isArray(d.links)],
  ['/v1/student/coordinators', (d) => typeof d.text === 'string'],
  ['/v1/calendar/lists', (d) => Array.isArray(d)],
  ['/v1/account/login-history', (d) => Array.isArray(d)],
];

console.log(`\n▸ data endpoints`);
for (const [path, assert] of checks) {
  const res = await call(path, { headers: auth });
  let ok = res.status === 200 && res.body?.ok === true;
  let detail = `HTTP ${res.status}`;
  if (ok) {
    try {
      ok = assert(res.body.data);
      detail += `, ${Array.isArray(res.body.data) ? res.body.data.length + ' items' : 'object'}`;
    } catch (e) {
      ok = false;
      detail += `, assertion threw: ${e.message}`;
    }
  } else {
    detail += ` ${res.body?.error?.code || ''}`;
  }
  log(ok, `GET ${path}`, detail);
}

console.log(`\n▸ aggregate`);
r = await call('/v1/dashboard', { headers: auth });
log(r.status === 200 && r.body?.ok === true, 'GET /v1/dashboard', `${JSON.stringify(r.body).length} bytes`);

console.log(`\n▸ auth guard`);
r = await call('/v1/student/profile');
log(r.status === 401, 'GET /v1/student/profile without key → 401', `HTTP ${r.status}`);

r = await call('/v1/student/profile', { headers: { Authorization: 'Bearer erp_bogus' } });
log(r.status === 401, 'bogus key → 401', `HTTP ${r.status}`);

console.log(`\n▸ logout`);
r = await call('/v1/auth/logout', { method: 'POST', headers: auth });
log(r.status === 200, 'POST /v1/auth/logout');
r = await call('/v1/auth/me', { headers: auth });
log(r.status === 401, 'key invalidated after logout', `HTTP ${r.status}`);

console.log(failures === 0 ? `\n✅ all checks passed\n` : `\n❌ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
