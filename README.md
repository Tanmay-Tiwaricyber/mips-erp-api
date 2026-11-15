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

Run the full end-to-end check against the real portal:

```bash
API_URL=http://localhost:3000 ERP_USER=2026BT0683 ERP_PASS='…' node examples/smoke.mjs
# ✅ all checks passed
```

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
