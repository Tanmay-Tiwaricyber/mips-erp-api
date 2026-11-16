# mips-erp-api

A REST API over the **MPGI / MIPS Asteroid365 student portal** (`erp.mpgi.net`) — built by reverse-engineering the portal's own AJAX endpoints, so your new ERP project can consume real student data as clean JSON instead of scraping HTML.

Every endpoint in here was exercised against the live portal.

```
POST /v1/auth/login   →  { apiKey }
GET  /v1/dashboard    →  profile + subjects + assessment + notices + calendar + classmates
GET  /v1/student/timetable
GET  /v1/notices?limit=20
...
```

---

## 👉 Setting this up in your own web + Android app

See **[SETUP.md](SETUP.md)** — step-by-step: deploy free on Render, mount the proxy in
your backend, then call it from the web app and the Android app.

## Quick start

```bash
npm install
npm start                      # → http://localhost:3000  (interactive docs at /)
```

```bash
# Log in (server solves the captcha, retries safely)
curl -X POST localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userId":"2026BT0683","password":"YOUR_PASS","institute":"MIPS"}'

# → {"ok":true,"data":{"apiKey":"erp_…","role":"Student","captchaAttempts":4,"solvedBy":"ocr"}}

# Use it
curl localhost:3000/v1/dashboard -H 'Authorization: Bearer erp_…'
```

Run the checks against the real portal:

```bash
export API_URL=http://localhost:3000 ERP_USER=2026BT0683 ERP_PASS='…'

node examples/smoke.mjs                  # 24 checks — every endpoint + auth guard
node examples/test-attendance-report.mjs # 27 checks — cumulative/month/subject attendance
node examples/test-daily.mjs             # 15 checks — daily attendance, all three states
node examples/test-peruser.mjs           # 12 checks — per-user token isolation

# the fee portal is a separate system with its own login
FEES_USER=YOUR_ENROLLMENT_NO FEES_PASS='…' node examples/test-fees.mjs   # 30 checks — dues, invoices, receipts
```

All five suites pass today. `test-daily.mjs` also accepts `DATE=2026-11-14` to pin the day
under test, and `capture-demo.mjs` re-records `examples/webapp/demo-data.json` from a
live session (so the demo UI never drifts from the real API).

---

## Endpoints

| Method | Path | What it returns |
|---|---|---|
| `GET` | `/healthz` | liveness |
| `GET` | `/v1/capabilities` | OCR status, session counts, route list |
| `GET` | `/v1/institutes` | known institute keys + uuids |
| `POST` | `/v1/auth/captcha` | step 1 — session + captcha image (base64) + OCR guess |
| `POST` | `/v1/auth/login` | step 2 — `{apiKey}` (manual captcha or `?auto=true`) |
| `POST` | `/v1/auth/logout` | end session |
| `GET` | `/v1/auth/me` | who am I |
| `GET` | `/v1/dashboard` | **all panels in one parallel call** |
| `GET` | `/v1/student/profile` | name, CRN, program, branch, semester, section, 210 raw fields |
| `GET` | `/v1/student/subjects` | subjects + codes + syllabus links |
| `GET` | `/v1/student/timetable` | weekly grid with teachers, rooms, LECTURE/LAB/TUTORIAL |
| `GET` | `/v1/student/attendance` | overall % + per-subject % |
| `GET` | `/v1/student/attendance/summary` | **cumulative totals + 12-month breakdown** — `?month=11\|November\|all` |
| `GET` | `/v1/student/attendance/by-subject` | **per-subject totals** (optional `?month=`), theory vs lab split |
| `GET` | `/v1/student/attendance/complete` | **every attendance view in one call** |
| `GET` | `/v1/student/attendance/daily` | **per-period attendance for one date** — `?date=YYYY-MM-DD\|DD-Mon-YYYY\|DD/MM/YYYY`; each period is `present`, `absent` or `not marked` |
| `GET` | `/v1/student/attendance/daily/history` | daily attendance across a range — `?from=&to=` (max 31 days), per-subject totals |
| `GET` | `/v1/student/assessment` | mid-sem, unit test, assignment marks |
| `GET` | `/v1/student/classmates` | class list with emails |
| `GET` | `/v1/student/documents` | important document links |
| `GET` | `/v1/student/coordinators` | class coordinators |
| `GET` | `/v1/student/no-dues` | no-dues status |
| `GET` | `/v1/student/todo` | to-do list |
| `GET` | `/v1/student/assignments` | assignment count |
| `GET` | `/v1/student/feedback` | open feedback forms |
| `GET` | `/v1/notices` | circulars — filters: `q`, `month`, `year`, `category`, `limit` |
| `GET` | `/v1/calendar/holidays` | holiday list |
| `GET` | `/v1/calendar/lists` | calendar lists |
| `GET` | `/v1/account/login-history` | recent logins + IPs |
| `GET` | `/v1/account/leave-balance` | leave balances |
| `POST` | `/v1/raw` | **escape hatch** — call any upstream `page.aspx/Method` |

`openapi.json` contains the full machine-readable spec (point Swagger UI / Postman at it).

## Two portals, one API

This service fronts **two unrelated college systems**. They share the API surface
and the `Authorization: Bearer` convention, but nothing else — a token from one is
rejected by the other (`401 WRONG_SYSTEM` on a prefix mismatch).

| | ERP | eLOGiPay |
|---|---|---|
| host | `erp.mpgi.net` | `www.elogisol.com/mpgi/` |
| what | attendance, timetable, marks, notices | **fees, dues, receipts, payments** |
| login | `POST /v1/auth/login` → `erp_…` | `POST /v1/fees/login` → `pay_…` |
| captcha | image, ~33%/attempt, needs 15 OCR retries | **plain text in the HTML** — no OCR at all |
| endpoints | `/v1/student/*`, `/v1/calendar/*` | `/v1/fees/*` |

### Fee portal (eLOGiPay)

The captcha on this system is not an image. The login page renders it as
`<span id="TxtCaptcha">3336</span>`, so login is a single GET plus a single POST
with one attempt. If that markup ever changes the API answers `502
CAPTCHA_UNAVAILABLE` rather than guessing.

```bash
# 1. log in with the enrollment number (not the ERP registration code)
curl -X POST localhost:3000/v1/fees/login \
  -H 'Content-Type: application/json' \
  -d '{"enrollmentNo":"YOUR_ENROLLMENT_NO","password":"…"}'
# → { "ok":true, "data":{ "apiKey":"pay_…", "user":{ "enrollmentNo":"…", "name":"TANMAY TIWARI (AI&ML)" } } }

# 2. everything in one call
curl localhost:3000/v1/fees/dashboard -H 'Authorization: Bearer pay_…'
```

| endpoint | returns |
|---|---|
| `POST /v1/fees/login` | `pay_…` token + student name/enrollment |
| `GET /v1/fees/dashboard` | dues totals, per-head split, every invoice line, payments |
| `GET /v1/fees/dues` | `totals`, `byHead[]`, `pendingHeads[]`, `settled` |
| `GET /v1/fees/invoices` | every line — `?type=FEE\|DISCOUNT\|RECEIPT\|REFUND` |
| `GET /v1/fees/receipts` | payment receipts |
| `GET /v1/fees/me` · `POST /v1/fees/logout` | session |

A live answer from this account:

```json
{ "totals": { "invoiceCount": 14, "charged": 713300, "receipts": 67500,
              "discounts": 580000, "outstanding": 65800 },
  "byHead": [ { "head": "INSTALLMENT-1", "charged": 142500, "receipts": 22500,
                "discounts": 120000, "balance": 65800 }, … ],
  "settled": false }
```

Money semantics worth knowing:

- **`invoiceType` is the sign of the line.** `FEE` is a charge, `RECEIPT` is a
  payment, `DISCOUNT` is a waiver, `REFUND` is money back. `balance` on each row
  is the *running* balance after that line, which is why it jumps around.
- **`outstanding` comes from the portal's own `hdnbalance`**, not from adding up
  the rows — the row balances are cumulative snapshots and can't be summed.
- **The fee receipt table is empty** for this account even though ₹67,500 has
  been paid. The real payment history is the `RECEIPT` lines; use
  `/v1/fees/invoices?type=RECEIPT`.
- **What this portal does not have:** no attendance, no timetable, no marks. It
  is the fee system only. Attendance lives on the ERP above — don't look for it
  here.

### Attendance — every view the portal has

The portal shows attendance in **three** different ways, and the API exposes all of
them plus one combined call:

| what the portal shows | endpoint | shape |
|---|---|---|
| "Cumulative Attendance" pie chart + totals row | `/v1/student/attendance/summary` | `present / absent / total / percent` + `byMonth[12]` |
| the report's per-subject grid | `/v1/student/attendance/by-subject` | one row per subject + `overall` + `byType{theory,lab}` |
| the class-by-class marks for a day | `/v1/student/attendance/daily` | one row per period: present / absent / not marked |
| all of the above at once | `/v1/student/attendance/complete` | cumulative + byMonth + bySubject |

```bash
# cumulative: 68 present, 25 absent, 93 lectures → 73%
GET /v1/student/attendance/summary
# → { "scope":"cumulative", "present":68, "absent":25, "total":93, "percent":73,
#     "byMonth":[ { "month":10, "monthName":"October", "present":45, "absent":12, "total":57, "percent":79 },
#                 { "month":11, "monthName":"November", "present":23, "absent":13, "total":36, "percent":64 }, … ],
#     "monthsWithLectures":["October","November"] }

# one month, either as a number or a name
GET /v1/student/attendance/summary?month=11
GET /v1/student/attendance/summary?month=November

# per subject, cumulatively or for a month
GET /v1/student/attendance/by-subject
GET /v1/student/attendance/by-subject?month=10
# → { "subjects":[ { "name":"Programming Languages", "code":"ACS101", "present":10,
#                    "absent":6, "total":16, "percent":62 }, … ],
#     "overall":{ "present":68, "absent":25, "total":93, "percent":73 },
#     "byType":{ "theory":[…], "lab":[…] } }
```

Three behaviours worth knowing:

- **`percent` is `null`, not `0`, when `total` is 0.** Six subjects have no marked
  lectures this term. That is "not marked yet", not "0% attendance" — don't render
  it as a zero bar.
- **The theory/lab split is done on the subject *name*, not the portal's `type`
  column.** The ERP labels lab subjects as `"Theory"`, so `byType` uses
  lab/practical/workshop/drawing detection instead. Use `byType`, not `type`.
- **The subject totals add up to the cumulative figure** (68/25/93 today). That is
  the check that proves the subject→id mapping is right, and it's asserted in
  `examples/test-attendance-report.mjs`.

**What the API cannot give you:** the ERP has no endpoint that lists individual
dated lecture records for a student. `getAttendance` returns aggregate counts only,
so "was I marked present in period 3 on 5 October" is only answerable through the
timetable grid (`/v1/student/attendance/daily`), one date at a time.

### Daily (per-period) attendance

Two endpoints, for the class-by-class view a student actually cares about:

```
GET /v1/student/attendance/daily?date=2026-11-16
GET /v1/student/attendance/daily/history?from=2026-11-09&to=2026-11-14
```

Every period carries one of **three** states — this is the bit most attendance
UIs get wrong, because the portal has no "Not Marked" markup at all: a period
that hasn't been marked simply has no attendance span.

```json
{
  "date": "16-Nov-2026",
  "weekday": "Monday",
  "summary": { "marked": 4, "present": 4, "absent": 0, "notMarked": 2, "percent": 100 },
  "periods": [
    { "period": 1, "slot": "09:45 AM - 10:35 AM", "subject": "Fundamentals of Electronics Engineering",
      "code": "AEC101A", "teacher": "Dr. ANJANEY NIGAM", "kind": "LECTURE",
      "attendance": null, "attendanceLabel": "Not Marked" },
    { "period": 2, "slot": "10:35 AM - 11:25 AM", "subject": "Professional Communication & Technical Writing",
      "code": "AAS105", "teacher": "Mrs. KOMAL TRIVEDI", "kind": "LECTURE",
      "attendance": "present", "attendanceLabel": "Present" }
  ],
  "present": [ { "subject": "…", "code": "AAS105" } ],
  "absent": [],
  "notMarked": [ { "subject": "…", "code": "AEC101A" } ]
}
```

| field | meaning |
|---|---|
| `attendance` | `"present"` \| `"absent"` \| `null` (= not marked yet) |
| `attendanceLabel` | ready-to-render text: `Present` / `Absent` / `Not Marked` |
| `summary.percent` | present ÷ marked (unmarked periods don't hurt the percentage) |
| `period` | position in the portal's grid, so lunch/gaps stay aligned |
| `periods[]` | real class slots only — empty grid holes and `LUNCH` are dropped |

`/v1/dashboard` includes the same object as `data.todayAttendance`
(a panel envelope: `{ ok, data }`), and `?date=YYYY-MM-DD` pins the day.

Notes: dates accept `2026-11-16`, `16-Nov-2026` or `16/11/2026`.
Future dates and holidays legitimately come back with everything unmarked;
Sundays have no classes. History is capped at 31 days (`RANGE_TOO_LARGE`),
skips Sundays, and defaults to the last 7 days.

---

## Auth: multi-user, isolated sessions

Each caller gets their own ERP cookie jar — nothing is shared.

**Auto (simplest)** — server solves the captcha and retries:
```json
POST /v1/auth/login
{ "userId": "2026BT0683", "password": "…", "institute": "MIPS" }
```

**Manual (most reliable)** — two steps, you read the image:
```
POST /v1/auth/captcha                        → { sessionId, captchaImage, ocrGuess }
POST /v1/auth/login { sessionId, userId, password, captcha }
```
If the captcha is wrong, the API answers `400 INVALID_CAPTCHA` **and drops a fresh
image into the response** on the same session, so your client just re-prompts.

Sessions are in-memory, keyed by `apiKey` (`erp_…`), expire after 25 min idle
(`SESSION_TTL_MS`), LRU-evicted at `MAX_SESSIONS`.

---

## The captcha problem (read this)

The login captcha is a 150×40 JPEG: 6 chars, `a-z0-9`, italic serif, red on white, with a strikethrough line.

I measured real accuracy against the live server over 40 captchas:

| approach | exact-answer accuracy |
|---|---|
| raw tesseract | 0–3% |
| + red-channel threshold | 20–32% |
| + enlarge/crop + line removal | 30–32% |
| + majority vote across variants | **~33%** |
| character segmentation | **1 blob per captcha — fails** |
| fixed 6-cell grid cropping | **fails** |

Glyphs are sheared *and* touching, so there is no clean split point — the segmentation
routes are dead ends. OCR is not going to be solved by tuning here; it needs a trainable
model (see below).

**Why auto-retry is still safe:** the ERP returns `LoginStatus: 9` ("Invalid Captcha")
with `InvalidLoginAttempt: 0` — captcha failures are **not counted** as failed logins
(verified: 4 consecutive captcha failures kept the counter at 0). So at 33 % per attempt,
`OCR_RETRIES=10` gives ≈98 % success on the first try. Observed in practice: 1–7 attempts,
2–5 s total.

> **Never introduce retries on `INVALID_CREDENTIALS`** — those *do* count and will lock the account.

### If you want near-100 % auto-solve
The captcha font is fixed and its alphabet is 32 chars. A tiny CNN trained on ~3–5k
labelled captchas (harvestable via `LoginStatus 9`, which is effectively free labelling)
reaches 95–99 % on this kind of captcha in a couple of hours of CPU training.
`src/captcha.js` has a single `solveCaptcha(image)` seam — swap the internals, keep the interface.

---

## Upstream endpoints reverse-engineered

All are `POST` with a JSON body, and return an ASP.NET `{ "d": … }` envelope.

| API route | upstream | notes |
|---|---|---|
| auth | `json/UserServiceWS.asmx/AuthenticateUser` | `{userId, passwds, vcaptcha, openFor:"Students", institute}` |
| captcha | `captchaHandler.ashx?query=…` | must share the cookie jar with login |
| role | `chooseURole.aspx/getRoles` → `btnNext_Click` | `{rId}` → `Dashboard?…&fi=…` |
| profile | `home.aspx/getStuDashboard_Details` | 210-field record |
| subjects | `home.aspx/getMySubjects` | HTML table |
| timetable | `json/TimeTableWS.asmx/StudentTimeTableWithAttendance` | `{student, attendanceDate, withAttendanceStatus:1}` |
| assessment | `examResult.aspx/getStu_ExamSummary` | `{roll}` |
| notices | `home.aspx/btnSearch_NoticeCirculars` | `{title, month, year, category, cFor:"S"}` |
| classmates | `home.aspx/getClassMates` | HTML |
| docs | `ImportantDocuments.aspx/GetSpecificDocumentLinks` | `{documentFor:"S"}` |
| holidays | `json/controlBindService.asmx/getAcademicCalendarItems` | `{calendarId:"7"}` |

**Two non-obvious gotchas** (both handled for you):

1. **Institute id matters.** Logging in against the wrong institute returns
   `LoginStatus 5` — identical to a wrong password. MIPS (Code 349) is
   `c372c15a-…`; MPEC (Code 046) is `b05cec9c-…`. Pass `institute: "MIPS"`.
2. **Session priming.** `getMySubjects` silently returns an *empty* table until the
   dashboard HTML has been fetched once in that session. `login()` now calls
   `primeDashboard()` so every panel is deterministic from the first request.

---

## Deploying

**Docker / Render / Railway / Fly** — plain Node, nothing special:
```bash
PORT=8080 node src/server.js
```

**Vercel** — `vercel.json` is included. Two caveats:
- Sessions are in-memory, so each serverless invocation is a **fresh process** → `apiKey`s
  won't survive between requests. Set `SESSION_TTL_MS` low and treat it as
  request-scoped, or put a Redis-backed store behind the two `Map`s in `src/server.js`
  (they are the only stateful part).
- `sharp`/`tesseract.js` inflate the bundle. Use `{"memory": 1024}` (already set) or run
  OCR as a separate service and drop the optional deps.
- Long OCR retry loops can approach the function timeout. `?auto=true` with
  `OCR_RETRIES=6` stays well inside 10 s.

For anything persistent, a plain container is a better fit than serverless.

### Environment variables

| var | default | purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | bind |
| `ERP_BASE_URL` | `https://erp.mpgi.net` | upstream |
| `SESSION_TTL_MS` | `1500000` (25 min) | idle session expiry |
| `MAX_SESSIONS` | `200` | LRU cap |
| `OCR_RETRIES` | `10` | captcha attempts before falling back to manual |
| `RATE_LIMIT` | `120` | requests / minute / key |
| `CORS_ORIGIN` | `*` | lock down for production |

---

## Security notes

- **Credentials are never stored.** They exist only for the duration of the login call.
  Only the resulting upstream cookies live in the session record.
- **Your password was shared in chat** — change it on the portal, then use the new one here.
- Upstream cookies are bearer-equivalent. Keep this service private (or behind your own
  auth) and don't expose `apiKey`s to the browser of someone you don't trust.
- This is **unofficial**. It depends on the portal's internal page methods, which the
  vendor can change without notice. Pin your integration to the shapes in `openapi.json`
  so a vendor change surfaces as a parse error, not silent bad data.
- Respect the portal: the default rate limit keeps you well below anything that looks
  like abuse.
