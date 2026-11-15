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

/** Parse the timetable fragment into { slots, days }. */
export function parseTimetable(html) {
  if (!html) return { slots: [], days: [] };
  const $ = cheerio.load(html);
  const table = $('table').first();
  const slots = [];
  table.find('tr').first().find('th').each((i, th) => {
    if (i === 0) return;
    slots.push(clean($(th).text()));
  });

  const days = [];
  table.find('tr').slice(1).each((_, tr) => {
    const tds = $(tr).find('td');
    if (!tds.length) return;
    const day = clean($(tds[0]).text());
    const periods = [];
    tds.slice(1).each((i, td) => {
      const text = clean($(td).text());
      if (!text) {
        periods.push(null);
        return;
      }
      if (/^lunch$/i.test(text)) {
        periods.push({ type: 'LUNCH' });
        return;
      }
      // "Name (CODE) Teacher [TYPE]"
      const b = $(td).find('b').first().text();
      const spans = $(td).find('span');
      const teacher = clean($(spans[0]).text());
      const kind = clean($(spans[spans.length - 1]).text()).replace(/[\[\]]/g, '');
      const namePart = clean(b);
      const m = namePart.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
      periods.push({
        subject: m ? clean(m[1]) : namePart,
        code: m ? clean(m[2]) : null,
        teacher: teacher || null,
        kind: kind || null,
        slot: slots[i] || null,
        room: /\bB\d+\b/.test(text) ? (text.match(/\bB\d+\b/) || [])[0] : null,
      });
    });
    days.push({ day, periods });
  });
  return { slots, days };
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

export const _internal = { clean };
