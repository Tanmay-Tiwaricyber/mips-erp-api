#!/usr/bin/env node
/**
 * Attendance-report test — every attendance view the portal itself shows.
 *
 *   API_URL=http://localhost:3000 ERP_USER=<id> ERP_PASS='<pw>' node examples/test-attendance-report.mjs
 *
 * Covers: cumulative totals, month breakdown, per-subject grid, and the combined
 * endpoint. Asserts the three shapes reconcile with each other, which is the only
 * way to prove the subject→id mapping in the portal's report is right.
 */
const API = process.env.API_URL || 'http://localhost:3000';
const USER = process.env.ERP_USER;
const PASS = process.env.ERP_PASS;

if (!USER || !PASS) {
  console.error('Set ERP_USER and ERP_PASS (never hardcode credentials).');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✔ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`✘ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const call = async (path, key, opts = {}) => {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log(`▸ attendance report  (${API})\n`);

const login = await call('/v1/auth/login', null, {
  method: 'POST',
  body: JSON.stringify({ userId: USER, password: PASS, institute: 'MIPS' }),
});
if (!login.body?.ok) {
  console.error('login failed:', JSON.stringify(login.body?.error));
  process.exit(1);
}
const key = login.body.data.apiKey;
check('POST /v1/auth/login', true, `captchaAttempts=${login.body.data.captchaAttempts}`);

try {
  // ------------------------------------------------------- cumulative totals
  const summary = await call('/v1/student/attendance/summary', key);
  const s = summary.body?.data;
  check('GET /v1/student/attendance/summary → 200', summary.status === 200, `HTTP ${summary.status}`);
  check('cumulative is present/absent/total', typeof s?.present === 'number' && typeof s?.total === 'number',
    `${s?.present}P / ${s?.absent}A of ${s?.total}`);
  check('percent is derived from the totals',
    s?.percent === (s.total ? Math.round((s.present * 100) / s.total) : null), `${s?.percent}%`);
  check('present + absent == total', s?.present + s?.absent === s?.total,
    `${s?.present}+${s?.absent}=${s?.total}`);
  check('byMonth covers all 12 months', Array.isArray(s?.byMonth) && s.byMonth.length === 12);
  check('monthsWithLectures is non-empty for an active student',
    Array.isArray(s?.monthsWithLectures) && s.monthsWithLectures.length > 0,
    s?.monthsWithLectures?.join(', '));

  // month rows must add up to the cumulative figure
  const monthSum = (s?.byMonth || []).reduce(
    (a, m) => ({ present: a.present + m.present, absent: a.absent + m.absent, total: a.total + m.total }),
    { present: 0, absent: 0, total: 0 }
  );
  check('byMonth sums to the cumulative total',
    monthSum.total === s?.total && monthSum.present === s?.present,
    `months ${monthSum.present}P/${monthSum.total} vs cumulative ${s?.present}P/${s?.total}`);

  // ---------------------------------------------------------- single month
  const nov = await call('/v1/student/attendance/summary?month=11', key);
  const n = nov.body?.data;
  check('GET …summary?month=11 → 200', nov.status === 200, `HTTP ${nov.status}`);
  check('month response names the month', n?.monthName === 'November' && n?.month === 11, n?.monthName);
  check('month totals reconcile', n?.present + n?.absent === n?.total, `${n?.present}+${n?.absent}=${n?.total}`);
  const novFromBreakdown = (s?.byMonth || []).find((m) => m.month === 11);
  check('month matches the same row in the breakdown',
    novFromBreakdown?.present === n?.present && novFromBreakdown?.total === n?.total,
    `${n?.present}P/${n?.total}`);

  const byName = await call('/v1/student/attendance/summary?month=November', key);
  check('month accepts a name too', byName.body?.data?.month === 11, byName.body?.data?.monthName);

  // ------------------------------------------------------------- by-subject
  const bs = await call('/v1/student/attendance/by-subject', key);
  const b = bs.body?.data;
  check('GET /v1/student/attendance/by-subject → 200', bs.status === 200, `HTTP ${bs.status}`);
  check('every registered subject appears', b?.subjects?.length === 15, `${b?.subjects?.length} subjects`);
  check('each row has present/absent/total/percent',
    b?.subjects?.every((r) => typeof r.present === 'number' && typeof r.total === 'number'));
  check('rows without lectures report percent null, not 0',
    b?.subjects?.filter((r) => r.total === 0).every((r) => r.percent === null),
    `${b?.subjects?.filter((r) => r.total === 0).length} unmarked subjects`);

  // the key correctness check: subject rows must add up to the cumulative figure
  check('by-subject sums to the cumulative total',
    b?.overall?.total === s?.total && b?.overall?.present === s?.present,
    `subjects ${b?.overall?.present}P/${b?.overall?.total} vs cumulative ${s?.present}P/${s?.total}`);

  check('theory/lab split covers every subject',
    (b?.byType?.theory?.length || 0) + (b?.byType?.lab?.length || 0) === b?.subjects?.length,
    `${b?.byType?.theory?.length} theory + ${b?.byType?.lab?.length} lab`);
  check('labs are classified as labs', (b?.byType?.lab?.length || 0) > 0,
    (b?.byType?.lab || []).map((r) => r.code).slice(0, 4).join(', '));

  // ---------------------------------------------------- per-subject per-month
  const bsNov = await call('/v1/student/attendance/by-subject?month=11', key);
  const bn = bsNov.body?.data;
  check('by-subject accepts a month filter', bsNov.status === 200 && bn?.month === 11, bn?.monthName);
  check('month-scoped subject totals ≤ cumulative totals',
    bn?.overall?.total <= b?.overall?.total,
    `Nov ${bn?.overall?.total} ≤ all ${b?.overall?.total}`);

  // ---------------------------------------------------------------- combined
  const full = await call('/v1/student/attendance/complete', key);
  const c = full.body?.data;
  check('GET /v1/student/attendance/complete → 200', full.status === 200, `HTTP ${full.status}`);
  check('complete embeds cumulative + byMonth + bySubject',
    typeof c?.cumulative?.present === 'number' && Array.isArray(c?.byMonth) && Array.isArray(c?.bySubject),
    `${c?.bySubject?.length} subjects, ${c?.byMonth?.length} months`);
  check('complete agrees with the individual endpoints',
    c?.cumulative?.total === s?.total && c?.bySubject?.length === b?.subjects?.length,
    `cumulative ${c?.cumulative?.present}P/${c?.cumulative?.total}`);

  // ------------------------------------------------------------- bad inputs
  const bad = await call('/v1/student/attendance/summary?month=smarch', key);
  check('unknown month → 400 BAD_MONTH', bad.status === 400 && bad.body?.error?.code === 'BAD_MONTH',
    bad.body?.error?.code);

  // ------------------------------------------- still works alongside daily
  const daily = await call('/v1/student/attendance/daily', key);
  check('per-period daily attendance still works', daily.status === 200 && Array.isArray(daily.body?.data?.periods),
    `${daily.body?.data?.periods?.length} periods`);
} finally {
  await call('/v1/auth/logout', key, { method: 'POST' });
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
