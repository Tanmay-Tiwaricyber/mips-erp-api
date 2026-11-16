/**
 * Parsers — the ERP returns most data as HTML fragments, not JSON.
 * These convert fragments into clean, stable JSON shapes for your ERP project.
 */
import * as cheerio from 'cheerio';

const clean = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();

/** Strip tags from a fragment and return normalised text. */
export function htmlToText(html) {
  if (!html) return '';
  const $ = cheerio.load(`<div id="__root">${html}</div>`);
  return clean($('#__root').text());
}

/** Parse a gridTable2-style table into an array of row objects keyed by header. */
export function parseGrid(html) {
  if (!html || typeof html !== 'string') return [];
  const $ = cheerio.load(html);
  const table = $('table').first();
  if (!table.length) return [];

  const headers = [];
  table.find('tr').first().find('th,td').each((_, el) => {
    headers.push(clean($(el).text()) || `col${headers.length + 1}`);
  });

  const rows = [];
  table.find('tr').slice(1).each((_, tr) => {
    const cells = $(tr).find('td,th');
    if (!cells.length) return;
    const row = {};
    cells.each((i, td) => {
      const key = headers[i] || `col${i + 1}`;
      row[key] = clean($(td).text());
    });
    // skip pure-header repeats / empty rows
    const vals = Object.values(row).filter(Boolean);
    if (vals.length) rows.push(row);
  });
  return rows;
}

/** Parse the "My Subjects" fragment. */
export function parseSubjects(html) {
  const $ = cheerio.load(html || '');
  const out = [];
  $('table tr').slice(1).each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;
    const link = $(tds[1]).find('a');
    const full = clean($(tds[1]).text());
    const m = full.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    out.push({
      serial: clean($(tds[0]).text()),
      name: m ? clean(m[1]) : full,
      code: m ? clean(m[2]) : null,
      type: clean($(tds[2]).text()),
      syllabusCoverage: clean($(tds[3]).text()),
      syllabusUrl: link.attr('href') || null,
    });
  });
  return out;
}

/**
 * Parse the timetable fragment.
 *
 * The ERP returns the FULL week grid for every request, but marks per-period
 * attendance only on the row matching the requested date. A cell looks like:
 *
 *   <b>Applied Chemistry…<br/>(AAS152D)</b>
 *   <span style='color:#666666;'>Dr. BRAJESH KR. MISHRA</span>
 *   <span style='font-size:smaller; color:#990000;'><i>B12</i></span>
 *   <span style='color:#D9534F;'>[LAB]</span>
 *   <span class='css-attendance-marked-absent'>Attendance : <b>Absent</b></span>
 *
 * A period with no attendance span has simply not been marked.
 */
export function parseTimetable(html, forDay = null) {
  const empty = {
    slots: [],
    days: [],
    attendanceDate: null,
    attendanceDay: null,
    attendanceSummary: { marked: 0, present: 0, absent: 0, notMarked: 0, percent: null },
  };
  if (!html) return empty;

  const $ = cheerio.load(html);
  const table = $('table').first();
  if (!table.length) return empty;

  const slots = [];
  table.find('tr').first().find('th').each((i, th) => {
    if (i === 0) return;
    slots.push(clean($(th).text()));
  });

  const DAYS = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;
  const days = [];

  for (const tr of table.find('tr').slice(1).toArray()) {
    const tds = $(tr).find('td').toArray();
    if (!tds.length) continue;
    const dayName = clean($(tds[0]).text());
    if (!DAYS.test(dayName)) continue;

    const periods = [];
    for (let i = 1; i < tds.length; i++) {
      const cellHtml = $(tds[i]).html() || '';
      const text = clean($(tds[i]).text());

      if (!text) {
        periods.push(null);
        continue;
      }
      if (/^lunch$/i.test(text)) {
        periods.push({ type: 'LUNCH', slot: slots[i - 1] || null });
        continue;
      }

      // Use selectors, not regex-on-HTML: cheerio normalises attribute quotes
      // and the ERP markup is malformed, so string matching is brittle.
      const $cell = $(tds[i]);
      const nameRaw = clean($cell.find('b').first().text());
      const codeMatch = nameRaw.match(/^(.*?)\s*\(([^()]+)\)\s*$/);

      let teacher = null;
      let room = null;
      $cell.find('span').each((_, sp) => {
        const style = $(sp).attr('style') || '';
        const cls = $(sp).attr('class') || '';
        if (cls.includes('attendance-marked')) return;
        if (style.includes('#666666')) teacher = clean($(sp).text()) || teacher;
        if (style.includes('#990000')) room = clean($(sp).text()) || room;
      });

      const kindMatch = text.match(/\[(LECTURE|LAB|TUTORIAL|PRACTICAL|OTHER)\]/i);

      // Attendance span: class="css-attendance-marked-present|absent"
      const attEl = $cell.find('span[class*="attendance-marked"]').first();
      const attClass = attEl.length ? attEl.attr('class') || '' : '';
      const attState = /present/i.test(attClass) ? 'present' : /absent/i.test(attClass) ? 'absent' : null;
      const attText = attEl.length ? clean(attEl.text()) : '';
      const notMarked = !attEl.length && /attendance[^]{0,20}not\s*marked/i.test(text);

      periods.push({
        slot: slots[i - 1] || null,
        subject: codeMatch ? clean(codeMatch[1]) : nameRaw,
        code: codeMatch ? clean(codeMatch[2]) : null,
        teacher: teacher || null,
        room: room || null,
        kind: kindMatch ? kindMatch[1].toUpperCase() : null,
        // 'present' | 'absent' | null (not marked yet)
        attendance: attState,
        attendanceLabel: attState
          ? clean(attText.replace(/^attendance\s*:?/i, '')) || (attState === 'present' ? 'Present' : 'Absent')
          : notMarked
            ? 'Not Marked'
            : null,
      });
    }
    days.push({ day: dayName, periods });
  }

  // Which row carries the marks? Normally the row for the requested date.
  // When the caller tells us the weekday, always report that row — a date with
  // nothing marked must still come back with its weekday and an empty summary.
  const markedDay = days.find((d) => d.periods.some((p) => p && p.attendance));
  const rowForDay = forDay ? days.find((d) => d.day === forDay) : markedDay;
  const teachingPeriods = rowForDay
    ? rowForDay.periods.filter((p) => p && p.type !== 'LUNCH')
    : [];
  const marked = teachingPeriods.filter((p) => p.attendance);
  const present = marked.filter((p) => p.attendance === 'present').length;
  const absent = marked.filter((p) => p.attendance === 'absent').length;

  return {
    slots,
    days,
    // the weekday the caller asked about (falls back to wherever marks were found)
    attendanceDay: rowForDay ? rowForDay.day : null,
    // transparency: which row the ERP actually attached marks to
    markedDay: markedDay ? markedDay.day : null,
    attendanceSummary: {
      marked: marked.length,
      present,
      absent,
      notMarked: teachingPeriods.length - marked.length,
      percent: marked.length ? +((present / marked.length) * 100).toFixed(1) : null,
    },
  };
}

/** Parse the student performance / assessment fragment. */
export function parseAssessment(html) {
  if (!html || typeof html !== 'string') return { subjects: [], totals: null };
  const $ = cheerio.load(html);
  const subjects = [];
  let totals = null;

  $('table tr').each((_, tr) => {
    // note: the ERP emits malformed markup in this grid (<td>…</th>), so accept both
    const tds = $(tr).find('td,th');
    if (!tds.length) return;
    const first = clean($(tds[0]).text());
    const name = clean($(tds[1]).text());
    const m = name.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    const row = {
      name: m ? clean(m[1]) : name,
      code: m ? clean(m[2]) : null,
      attendance: clean($(tds[2]).text()),
      midSemMarks: clean($(tds[3]).text()),
      midSemMax: clean($(tds[4]).text()),
      unitTest: clean($(tds[5]).text()),
    };
    if (/^\d+$/.test(first)) subjects.push({ serial: Number(first), ...row });
    else if (/^total$/i.test(first)) {
      // Footer layout differs from the body: label | "<pct> %" | obtained | max | ...
      const c = [];
      tds.each((i, td) => { c[i] = clean($(td).text()); });
      totals = {
        attendancePercent: c[1] || null,
        midSemObtained: c[2] || null,
        midSemMax: c[3] || null,
        unitTestObtained: c[4] || null,
        unitTestMax: c[5] || null,
      };
    }
  });
  return { subjects, totals };
}

/** Parse circulars/notices JSON payload into plain objects. */
export function parseNotices(list) {
  return (list || []).map((n) => ({
    id: n.Id_P,
    date: n.postedOn_P,
    category: n.Category_P,
    isNew: n.newC_P === 'Y',
    title: htmlToText(n.message_P).replace(/\s*click here\.?$/i, '').trim(),
    html: n.message_P,
  }));
}

/** Parse the holiday / academic-calendar fragment. */
export function parseCalendar(html) {
  return parseGrid(html || '').map((r) => ({
    serial: Number(r['S.No.']) || null,
    name: r.Particulars,
    dates: r['Date(s)'],
  }));
}

/** Parse classmates fragment. */
export function parseClassmates(html) {
  if (!html) return [];
  const $ = cheerio.load(`<div>${html}</div>`);
  const out = [];
  $('.cmatesInfo').each((_, el) => {
    const t = clean($(el).text());
    const name = (t.match(/Name\s*:\s*(.*?)\s*Admission Code/i) || [])[1];
    const code = (t.match(/Admission Code\s*:\s*(\S+)/i) || [])[1];
    const email = (t.match(/E-Mail Id\.?\s*:\s*(\S+)/i) || [])[1];
    if (name || code) out.push({ name: clean(name), admissionCode: code, email: email || null });
  });
  return out;
}

/** Parse login-history fragment. */
export function parseLoginHistory(html) {
  return [...(html || '').matchAll(/<b>Date\s*:<\/b>\s*([^<]+)<br\s*\/?><b>IP Address\s*:<\/b>\s*([^<]+)/gi)].map(
    (m) => ({ date: clean(m[1]), ip: clean(m[2]) })
  );
}

/** Normalise the big getStuDashboard_Details record into a tidy student profile. */
export function normaliseProfile(r = {}) {
  return {
    registrationCode: r.stuRegistrationCode_P ?? null,
    fullName: r.studentFullName_P ?? null,
    nameInHindi: r.NameInHindi ?? null,
    rollNo: r.rollno_P ?? null,
    enrollmentNo: r.enrollmentno_P ?? null,
    examRollNo: r.examRollNoe_P ?? null,
    program: r.prgName_P ?? null,
    branch: r.branch_P ?? r.branchName_P ?? null,
    semester: r.stuSem_P ?? null,
    section: r.section_P ?? null,
    batch: r.batchName_P ?? null,
    institute: r.instName_P ?? null,
    dateOfBirth: r.dob_P ?? null,
    gender: r.gender_P ?? null,
    email: r.emailId_P ?? null,
    mobile: r.mobileno_P ?? null,
    fatherName: r.fatherName_P ?? null,
    motherName: r.motherName_P ?? null,
    fatherMobile: r.fatherMobile_P ?? null,
    motherMobile: r.motherMobile_P ?? null,
    category: r.casteCategory_P ?? null,
    admissionMode: r.admissionMode_P ?? null,
    isHostelMember: Boolean(r.IsHostelMember),
    isTransportMember: Boolean(r.IsTransportMember),
    hasPhoto: Boolean(r.HasPhoto),
    hasSignature: Boolean(r.HasSignature),
    raw: r,
  };
}

/**
 * Parse the "present,absent,total" string that viewStuAttendance_rpt.aspx/getAttendance
 * returns, into a { present, absent, total, percent } object.
 *
 * The portal itself writes `68,25,93` — present, absent, total lectures. A zero
 * total means "no lectures in this slice", NOT a missing section, so percent is
 * null rather than 0 (a student with no marked lectures hasn't failed anything).
 */
export function parseAttendanceCounts(raw) {
  const parts = String(raw ?? '')
    .split(',')
    .map((x) => x.trim());
  const present = Number.parseInt(parts[0], 10);
  const absent = Number.parseInt(parts[1], 10);
  const total = Number.parseInt(parts[2], 10);
  const ok = [present, absent, total].every((n) => Number.isFinite(n));
  if (!ok) return { present: null, absent: null, total: null, percent: null, raw: String(raw ?? '') };
  return {
    present,
    absent,
    total,
    // the portal shows Math.round(present/total*100)
    percent: total ? Math.round((present * 100) / total) : null,
    raw: String(raw ?? ''),
  };
}

/**
 * The subject-list grid (home.aspx/getMySubjects) is the only place the portal
 * exposes the numeric subject id used by the attendance report. It rides along
 * inside each syllabus link as `sd=1502`, so pull it out here once.
 */
export function parseSubjectIds(html) {
  const $ = cheerio.load(html || '');
  const map = new Map();
  $('table tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    const a = $(tds[1]).find('a');
    const href = a.attr('href') || '';
    const sd = (href.match(/[?&]sd=(\d+)/) || [])[1];
    const full = clean($(tds[1]).text());
    const m = full.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    const name = m ? clean(m[1]) : full;
    const code = m ? clean(m[2]) : null;
    if (sd) map.set(sd, { sd: Number(sd), name, code, type: clean($(tds[2]).text()) });
  });
  return map;
}

/** Month names the ERP's attendance report uses (1-12), plus a lookup helper. */
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Resolve a month filter to the numeric form the report wants.
 * Accepts 0/"0"/"all"/null → 0 (cumulative), 1-12, or a month name.
 * Returns null when the input can't be understood.
 */
export function parseMonthFilter(input) {
  if (input === undefined || input === null || input === '') return 0;
  const s = String(input).trim().toLowerCase();
  if (s === '0' || s === 'all' || s === 'cumulative' || s === 'total') return 0;
  const n = Number.parseInt(s, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 12) return n;
  const idx = MONTH_NAMES.findIndex((m) => m.toLowerCase() === s || m.toLowerCase().slice(0, 3) === s.slice(0, 3));
  return idx >= 0 ? idx + 1 : null;
}

export const _internal = { clean };
