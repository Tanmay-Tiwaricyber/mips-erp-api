#!/usr/bin/env node
/**
 * Re-capture examples/webapp/demo-data.json from the live API.
 *
 *   API_URL=http://localhost:3000 ERP_USER=<id> ERP_PASS='<pw>' node examples/capture-demo.mjs
 *
 * The web demo's "demo account" button renders this file, so it must contain the
 * same mix the UI reads: the /v1/dashboard panels plus the standalone timetable
 * and subject-attendance payloads (neither of which /v1/dashboard returns).
 *
 * Contains real student data → keep it out of any public repo you don't control.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL || 'http://localhost:3000';
const USER = process.env.ERP_USER;
const PASS = process.env.ERP_PASS;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'webapp', 'demo-data.json');

if (!USER || !PASS) {
  console.error('Set ERP_USER and ERP_PASS (never hardcode credentials).');
  process.exit(1);
}

const login = await fetch(`${API}/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: USER, password: PASS, institute: 'MIPS' }),
});
const lj = await login.json();
if (!lj.ok) {
  console.error('login failed:', JSON.stringify(lj.error));
  process.exit(1);
}
const key = lj.data.apiKey;
const h = { Authorization: `Bearer ${key}` };
const get = async (p) => {
  const res = await fetch(API + p, { headers: h });
  const body = await res.json();
  if (!body.ok) throw new Error(`${p} → ${body.error?.code}: ${body.error?.message}`);
  return body.data;
};

try {
  const [dash, timetable, attendance, summary, bySubject] = await Promise.all([
    get('/v1/dashboard'),
    get('/v1/student/timetable'),
    get('/v1/student/attendance'),
    get('/v1/student/attendance/summary'),
    get('/v1/student/attendance/by-subject'),
  ]);

  // The dashboard hands today's attendance back as a {ok,data} panel; the demo
  // file stored the flattened object, so flatten it again for a clean fixture.
  // A cold upstream sometimes returns an empty grid; never bake that into the
  // demo fixture, the UI would silently render blank cards.
  if (!timetable?.days?.length) {
    throw new Error('timetable came back empty — retry (the ERP occasionally returns a blank grid)');
  }
  if (!attendance?.bySubject?.length) {
    throw new Error('subject attendance came back empty — retry');
  }

  const today = dash.todayAttendance;
  const demo = {
    ...dash,
    todayAttendance: today && today.data ? today.data : today,
    timetable,
    attendance,
    // cumulative + month breakdown + per-subject grid — the attendance report card
    attendanceReport: {
      cumulative: {
        present: summary.present, absent: summary.absent,
        total: summary.total, percent: summary.percent,
      },
      byMonth: summary.byMonth,
      monthsWithLectures: summary.monthsWithLectures,
      bySubject: bySubject.subjects,
      byType: bySubject.byType,
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(demo, null, 1));
  const t = demo.todayAttendance || {};
  console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
  console.log(`  today    : ${t.date} ${t.weekday} — ${t.periods?.length || 0} periods ` +
    `${t.summary?.present || 0}P/${t.summary?.absent || 0}A/${t.summary?.notMarked || 0}NM`);
  console.log(`  timetable: ${timetable.days?.length || 0} days × ${timetable.slots?.length || 0} slots`);
  console.log(`  subjects : ${attendance.bySubject?.length || 0} with attendance, overall ${attendance.overall?.percent}%`);
  console.log(`  report   : ${summary.present}P/${summary.absent}A of ${summary.total} = ${summary.percent}% ` +
    `(${summary.monthsWithLectures?.join(', ')})`);
  console.log(`  byType   : ${bySubject.byType?.theory?.length || 0} theory, ${bySubject.byType?.lab?.length || 0} lab`);
} finally {
  await fetch(`${API}/v1/auth/logout`, { method: 'POST', headers: h });
}
