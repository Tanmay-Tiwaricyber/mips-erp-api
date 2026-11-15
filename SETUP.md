# Setting up mips-erp-api in your ERP — web app + Android

One backend API serves both apps. You deploy **one** service, then both clients call it.

```
  Browser (React/Vue/plain)  ─┐   userId + password
                              ├──────────────┐
  Android app (Kotlin/Java)  ─┘              ▼
                                    YOUR backend (proxy)
                                     · logs in AS THAT USER
                                     · keeps the ERP key server-side
                                     · returns an opaque token
                                            │
                                            ▼
                                  mips-erp-api ──→ erp.mpgi.net
                                  (ERP adapter)     (one session per student)
```

**Each user signs in with their own credentials and only ever sees their own data.**
The apps never hold the ERP `apiKey`, and the backend never keeps a password — only the
short-lived token that maps to that student's ERP session.

---

## Step 1 — Run the API locally (5 minutes)

```bash
cd mips-erp-api
npm install
npm start                 # → http://localhost:3000
```

Check it:

```bash
curl -X POST localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userId":"2026BT0683","password":"YOUR_PASS","institute":"MIPS"}'
# {"ok":true,"data":{"apiKey":"erp_…","captchaAttempts":2,"solvedBy":"ocr"}}
```

Interactive route list is at <http://localhost:3000/>. Full spec in `openapi.json`.

---

## Step 2 — Deploy it (free, no card)

**Use Render.** It's the only free tier in 2026 with no credit card, 750 instance-hours
per month (enough for one always-on service) and 512 MB RAM. Railway gives $5 trial
credit then ~$1/month (tighter); Koyeb needs a card with a $29 hold; Fly.io has no
free tier any more; Vercel is serverless and this API keeps sessions in memory, so a
`apiKey` dies between invocations.

```bash
# 1. push the folder to GitHub
# 2. Render dashboard → New → Blueprint → pick your repo
#    (render.yaml is included — it sets Docker, free plan, health check, env vars)
# 3. wait for the build, copy your URL:
#    https://mips-erp-api.onrender.com
```

Verify the deploy:

```bash
curl https://mips-erp-api.onrender.com/healthz
# {"ok":true,"upstream":"https://erp.mpgi.net","uptime":1.2}
```

Two caveats to plan around:

- **It sleeps after 15 min idle**, and the first request then takes 30–60 s. Show a
  "waking the server…" state in your UI, or ping `/healthz` from a free cron
  (e.g. cron-job.org every 10 min) to keep it warm.
- **512 MB RAM.** tesseract.js uses ~150–190 MB. If you get OOM restarts, set
  `ENABLE_OCR=false` on Render — the API falls back to manual captcha only, still fully
  functional, using ~60 MB.

Anything else with Docker works identically: `docker build -t mips-erp-api . && docker run -p 3000:3000 mips-erp-api`.

---

## Step 3 — Add the proxy to your backend (per-user login)

`examples/server-plugin/erp-proxy.js` implements exactly the flow you described:

> user types their own user ID + password → API logs in **as that user** → token → their data

```js
import { createErpProxy } from './erp-proxy.js';

app.use('/api/erp', createErpProxy({
  apiBase: process.env.MIPS_ERP_API_URL,   // https://mips-erp-api.onrender.com
}));
```

**No credentials go in the config.** There is no shared account — every token traces
back to one real student login.

### The API your app talks to

| Call | Purpose |
|---|---|
| `POST /api/erp/login` `{userId, password}` | → `{token, user}` · **401 if credentials are wrong** |
| `POST /api/erp/captcha` | optional: `{sessionId, captchaImage}` for manual captcha |
| `POST /api/erp/login-captcha` `{sessionId, userId, password, captcha}` | manual-captcha login |
| `GET /api/erp/me` | which user this token belongs to |
| `GET /api/erp/student/*`, `/notices`, `/calendar/*` | that user's data (`X-Session-Token`) |
| `POST /api/erp/logout` | end the session |

### Guarantees, verified against the live ERP

```
✔ wrong password rejected at proxy — 401 INCORRECT_PASSWORD, no token issued
✔ no e-mail address leaked in error
✔ user login → token — user=2026BT0683
✔ upstream apiKey not exposed to browser
✔ /me identifies the user → 2026BT0683
✔ profile / attendance / timetable / notices belong to that user
✔ second login → distinct token; both sessions independently valid
✔ logged-out token → 401; sibling token still works
```

- **Passwords are never stored or logged.** They exist only inside the login call.
- **Token isolation:** two users get two tokens mapped to two separate ERP sessions.
  There is no path for one token to read another user's data.
- **Token TTL = 20 min** (the ERP's own session idles out ~25 min). On expiry the app
  gets `401 SESSION_EXPIRED` and must ask for the password again — we can't refresh
  silently, because we deliberately don't keep the password.
- **Brute-force guard:** 8 credential failures per IP per 10 minutes → `429 TOO_MANY_ATTEMPTS`.
  This matters: the ERP itself locks accounts.

### ⚠️ One behaviour you must design around

A wrong password for a **valid** user id does not just fail — the college ERP
**e-mails the student their current credentials** and counts a failed attempt.

So:

- **Never auto-retry a 401.** Retrying re-sends that e-mail and burns lockout budget.
- Show the `notice` field from the error response so the user knows to check their inbox.
- Only captcha failures are safe to retry (they don't count, verified: 4 in a row kept
  `InvalidLoginAttempt: 0`).

The proxy already enforces all three: it distinguishes `INCORRECT_PASSWORD` from
`INVALID_CREDENTIALS`, never exposes the masked e-mail address, and only counts real
credential failures toward the rate limit.

> Not using Node? Any HTTP client can play this role — it's just "log in as the user,
> keep the returned key server-side, forward with `Authorization: Bearer`".

---

## Step 4 — Web app

`examples/webapp/` is a working login page: enter **your own** user ID and password,
get your own dashboard. Run it:

```bash
cd examples/webapp
MIPS_ERP_API_URL=http://localhost:3000 node serve.js    # → http://localhost:4200
```

No credentials needed in the environment — each visitor signs in themselves.

**Plain HTML/JS** — copy `mips-erp.js`:

```html
<script src="mips-erp.js"></script>
<script>
  const erp = new MipsErp({ baseUrl: '/', mode: 'proxy' });

  // 1. user submits your login form
  await erp.proxyLogin(userId, password);   // throws with .code on bad credentials

  // 2. fetch their data
  const [profile, attendance, timetable] = await Promise.all([
    erp.profile(), erp.attendance(), erp.timetable(),
  ]);
</script>
```

**React** — the whole login screen is ~20 lines:

```jsx
function LoginPage() {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const erp = useMemo(() => new MipsErp({ baseUrl: '/', mode: 'proxy' }), []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await erp.proxyLogin(userId, password);
      navigate('/dashboard');               // token stays in memory or sessionStorage
    } catch (e) {
      setErr(e.message);                    // "Incorrect password for this user ID."
      if (e.body?.error?.notice) setErr(e.message + ' ' + e.body.error.notice);
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit}>
      <input value={userId} onChange={e => setUserId(e.target.value)} placeholder="User ID" />
      <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" />
      <button disabled={busy}>{busy ? 'Signing in…' : 'Log in'}</button>
      {err && <p className="error">{err}</p>}
    </form>
  );
}
```

Show a *slow* spinner on submit: the server may need several captcha attempts (2–10 s).

---

## Step 5 — Android app

`examples/android/` has `ApiClient.kt`, `MipsErpApi.kt`, `Models.kt`, `ErpRepository.kt`,
`ErpViewModel.kt`. Retrofit + OkHttp + coroutines.

```kotlin
// Application.onCreate()
TokenStore.init(this)          // token is stored in EncryptedSharedPreferences

// ViewModel — pass whatever the user typed
viewModel.login(userId, password)                  // auto captcha
viewModel.state.collect { ui -> render(ui) }        // StateFlow: loading / error / data

// or manual captcha UX
viewModel.startManualCaptcha()                      // loads base64 image
viewModel.submitCaptcha(userId, password, "e34780") // wrong → fresh image auto-loaded
```

Gradle deps and the manifest permission snippet are in `examples/android/README.md`.

**These were really compiled** — `kotlinc 1.9.24` against Retrofit/OkHttp/kotlinx-serialization,
then the data classes were run on the JVM against a live API capture:

```
subjects decoded: 15 -> first = Applied Chemistry for Smart Systems (AAS102D)
timetable decoded: days=6, slots=8, lunch at index 3
attendance decoded: overall=72.0% (source=assessment-grid), subjects=15
notices decoded: count=100, newest=05-Nov-2026
profile decoded: TANMAY TIWARI / B.Tech AIML sem 1 AIML-1B-1
```

`ModelRoundTripTest.kt` is included — run it when the ERP changes shape and it'll fail loudly
instead of showing blank screens.

Three Android specifics:

- **Timeouts:** login can take 2–8 s (captcha OCR retries), and a cold Render start adds
  30–60 s. Use a 75 s read timeout (already set) and show a waking-up message.
- **Never log bodies in release.** Student data is personal; `HttpLoggingInterceptor` is
  set to `BASIC` in debug and `NONE` in release.
- **Emulator → host:** `localhost` inside the emulator is the emulator itself. Use
  `10.0.2.2` to reach a server on your dev machine.

---

## What the data looks like

```jsonc
// GET /api/erp/student/attendance
{
  "overall": { "percent": 72, "present": 0, "absent": 0, "totalLectures": 0, "source": "assessment-grid" },
  "bySubject": [
    { "name": "Applied Chemistry for Smart Systems", "code": "AAS102D", "percent": 79 },
    { "name": "Programming Languages",               "code": "ACS101",  "percent": 60 }
  ]
}

// GET /api/erp/student/timetable
{
  "asOf": "15-Nov-2026 05:53:45 PM",
  "slots": ["09:45 AM - 10:35 AM", "…"],
  "days": [
    { "day": "Monday", "periods": [
      { "subject": "Fundamentals of Electronics Engineering", "code": "AEC101A",
        "teacher": "Dr. ANJANEY NIGAM", "kind": "LECTURE", "slot": "09:45 AM - 10:35 AM", "room": null },
      { "type": "LUNCH" }
    ]}
  ]
}
```

---

## Gotchas that will bite you (all handled inside the API)

| Symptom | Cause | Fix |
|---|---|---|
| `LoginStatus 5` = "invalid password" but the password is right | wrong **institute id** — MIPS (349) and MPEC (046) are different uuids | always pass `institute: "MIPS"` |
| `student/subjects` returns `[]` | the portal needs the dashboard HTML fetched once to seed session state | `login()` now primes it |
| Login fails ~2/3 of the time | captcha OCR is only ~33% accurate per attempt | API retries up to 10× — captcha failures are **not** counted as failed logins (verified: 4 in a row kept `InvalidLoginAttempt: 0`) |
| Account locked after a few tries | retrying a 401 | never auto-retry credential failures — they count toward lockout |
| Student gets a surprise e-mail with their password | wrong password for a valid user id — the ERP **e-mails credentials** | show the `notice` message; do not retry silently |

---

## Production checklist

- [ ] Change your ERP password (it was shared in plain text), update `MIPS_ERP_PASS`
- [ ] `CORS_ORIGIN` set to your webapp origin, not `*`
- [ ] Keep the brute-force guard on `/api/erp/login` (8 failures / IP / 10 min is the default)
- [ ] Consider your own account layer if you need roles beyond the college login
- [ ] Never auto-retry a 401 — it triggers the ERP's credential e-mail and lockout
- [ ] `ENABLE_OCR=false` if Render OOM-restarts
- [ ] Keep-alive cron on `/healthz` if 30–60 s cold starts are unacceptable
- [ ] Never ship the ERP `apiKey` in a client bundle or APK — the proxy holds it
- [ ] Clear the stored token on logout (both clients already do)
- [ ] Cache read-only data (timetable, holidays) client-side for 15 min

---

## Files in this folder

```
mips-erp-api/
├── src/                              the API itself
├── openapi.json                      import into Postman / Swagger UI
├── render.yaml                       one-click free deploy
├── Dockerfile
└── examples/
    ├── webapp/
    │   ├── index.html                working dashboard UI
    │   ├── mips-erp.js               browser + React Native client (UMD, XHR fallback)
    │   ├── serve.js                  runs the UI + mounts the proxy
    │   └── demo-data.json            real captured data for offline demo
    ├── server-plugin/erp-proxy.js    ← drop this into YOUR backend
    ├── android/                      Retrofit client, models, repository, ViewModel
    └── smoke.mjs                     end-to-end test (24 checks)
```
