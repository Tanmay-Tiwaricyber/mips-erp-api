# Deploy & set up — the whole thing in order

Follow this top to bottom. Every command is copy-pasteable. Total time: **~25 minutes**,
of which ~10 is waiting for builds.

At the end you'll have:

```
https://mips-erp-api.onrender.com        ← the API (free, always on*)
https://your-webapp.com/api/erp/...      ← your app's proxy → the API
Android app → your proxy                 ← same surface as the web app
```

\* sleeps after 15 min idle; see [Step 6](#step-6--keep-it-awake-optional) to prevent that.

---

## Before you start

| You need | Why |
|---|---|
| GitHub account | Render deploys from a repo |
| Render account | free, **no credit card** |
| Your ERP user ID + password | to test that login works |
| Node 18+ on your machine | to run it locally first |

> **Do the password change now:** the one you've been pasting in chat is compromised.
> Log into the portal, change it, and use the new one from here on.

---

## Step 1 — Run it locally first (5 min)

Never debug on a server. Get it working locally first.

```bash
cd mips-erp-api

npm install          # ~30 s, installs express + cheerio (+ sharp/tesseract.js for OCR)
npm start            # → listening on http://0.0.0.0:3000
```

In a second terminal:

```bash
# health
curl localhost:3000/healthz
# {"ok":true,"upstream":"https://erp.mpgi.net","uptime":1.2}

# log in with YOUR credentials
curl -X POST localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userId":"2026BT0683","password":"YOUR_NEW_PASS","institute":"MIPS"}'
```

Expected: `{"ok":true,"data":{"apiKey":"erp_...","captchaAttempts":2,"solvedBy":"ocr"}}`

- `captchaAttempts: 1–7` is normal (OCR is ~33% per try).
- If it fails **every** time with `CAPTCHA_OCR_FAILED`, use the manual path below —
  it's 100% reliable.

**Manual captcha (recommended if OCR struggles):**

```bash
curl -X POST localhost:3000/v1/auth/captcha -H 'Content-Type: application/json' -d '{}'
# → sessionId + captchaImage (data:image/jpeg;base64,...)
# open the base64 in a browser, read the 6 chars, then:
curl -X POST localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<from above>","userId":"2026BT0683","password":"...","captcha":"e34780"}'
```

**Now run the full self-test — this must print `✅ all checks passed`:**

```bash
API_URL=http://localhost:3000 \
ERP_USER=2026BT0683 ERP_PASS='YOUR_NEW_PASS' \
node examples/smoke.mjs
```

That runs 24 checks: login, all 17 data endpoints, auth guards, logout. Don't continue
until it's green.

---

## Step 2 — Push to GitHub

```bash
cd mips-erp-api

# make sure secrets are NOT committed
cat .gitignore        # must contain: node_modules/  .env
ls .env 2>/dev/null   # if this exists, it must stay untracked

git init
git add .
git commit -m "MIPS ERP API"
git branch -M main
git remote add origin https://github.com/YOURNAME/mips-erp-api.git
git push -u origin main
```

Before pushing, confirm no credentials are in the repo:

```bash
git grep -i -n "Tanmay@\|MIPS_ERP_PASS=" -- . ':!*.md' || echo "clean ✔"
```

---

## Step 3 — Deploy to Render (5 min)

Free tier: **750 instance-hours/month, 512 MB RAM, no credit card**.
(Verified Nov 2026. Railway gives ~$1/month credit, Koyeb wants a card + $29 hold,
Fly.io has no free tier, Vercel is serverless — sessions wouldn't survive between
invocations.)

### 3a. Create the service

1. Go to <https://dashboard.render.com> → **New +** → **Web Service**
2. Connect GitHub → pick your `mips-erp-api` repo
3. Fill in:

   | Field | Value |
   |---|---|
   | Name | `mips-erp-api` |
   | Region | **Singapore** (closest to Kanpur) |
   | Language | **Docker** |
   | Dockerfile path | `./Dockerfile` |
   | Instance type | **Free** |
   | Health check path | `/healthz` |

4. **Environment variables** — click *Advanced* → *Add Environment Variable*:

   | Key | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `ENABLE_OCR` | `true` |
   | `OCR_RETRIES` | `15` |
   | `MAX_SESSIONS` | `50` |
   | `SESSION_TTL_MS` | `1500000` |
   | `RATE_LIMIT` | `120` |
   | `CORS_ORIGIN` | `*` *(tighten later — Step 7)* |

   **Do not add `MIPS_ERP_USER` / `MIPS_ERP_PASS`.** The API takes per-user
   credentials at login; there is no server-side account.

5. Click **Deploy Web Service**. First build takes ~3–5 min.

### 3b. Verify the deploy

```bash
export API_URL=https://YOUR-SERVICE.onrender.com   # from the Render dashboard

curl $API_URL/healthz
# {"ok":true,"upstream":"https://erp.mpgi.net","uptime":1.2}

curl $API_URL/v1/capabilities | head -c 200
# should show "ocrAvailable":true
```

Then run the same 24-check suite against production:

```bash
API_URL=$API_URL ERP_USER=2026BT0683 ERP_PASS='YOUR_NEW_PASS' node examples/smoke.mjs
```

### 3c. If it misbehaves

| Symptom | Fix |
|---|---|
| Build fails on `sharp` | Dockerfile already handles it; check the log for a missing `libvips` |
| Restarts every few minutes | out of 512 MB → set `ENABLE_OCR=false`, redeploy (drops to ~69 MB, manual captcha only) |
| `CAPTCHA_OCR_FAILED` often | raise `OCR_RETRIES` to `25`; or switch the app to manual captcha |
| 502 on first request | cold start — wait 60 s and retry |
| `ocrAvailable:false` when you expected true | `ENABLE_OCR` is set to `false` |

> **Memory reality check (measured in this sandbox):** idle with OCR enabled =
> **80 MB**, OCR disabled = **69 MB**. Render's 512 MB is enough — the crash risk is
> many concurrent OCR jobs, which is why `MAX_SESSIONS=50` and the rate limit matter.

---

## Step 4 — Mount the proxy in your own backend

The API alone shouldn't be called by an APK or a public web page. Add ~20 lines.

```bash
cp -r mips-erp-api/examples/server-plugin ./your-backend/lib/
```

```js
// your-backend/server.js
import express from 'express';
import { createErpProxy } from './lib/server-plugin/erp-proxy.js';

const app = express();

app.use('/api/erp', createErpProxy({
  apiBase: process.env.MIPS_ERP_API_URL,   // https://YOUR-SERVICE.onrender.com
}));

app.listen(process.env.PORT || 8080);
```

Set on your backend: `MIPS_ERP_API_URL=https://YOUR-SERVICE.onrender.com`

That's the entire integration. Your app now talks to **your** domain:

| Your app calls | Proxy does |
|---|---|
| `POST /api/erp/login` `{userId, password}` | logs in **as that user**, returns an opaque token |
| `GET /api/erp/student/attendance` + `X-Session-Token` | forwards with the server-side ERP key |
| `POST /api/erp/logout` | ends that session |

Test it:

```bash
# wrong password must be rejected
curl -s -X POST localhost:8080/api/erp/login -H 'Content-Type: application/json' \
  -d '{"userId":"2026BT0683","password":"wrong"}' -w '\n%{http_code}\n'
# → {"error":{"code":"INCORRECT_PASSWORD",...}}  401

# real login
TOKEN=$(curl -s -X POST localhost:8080/api/erp/login -H 'Content-Type: application/json' \
  -d '{"userId":"2026BT0683","password":"YOUR_NEW_PASS"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -s localhost:8080/api/erp/student/profile -H "X-Session-Token: $TOKEN" | head -c 200
```

The proxy ships with its own test suite — `node examples/test-peruser.mjs` (12 checks:
wrong password rejected, token isolation, logout, sibling sessions).

---

## Step 5 — Point the two apps at it

### 5a. Web app

```bash
cd mips-erp-api/examples/webapp
MIPS_ERP_API_URL=https://YOUR-SERVICE.onrender.com node serve.js   # → http://localhost:4200
```

Open it, type your credentials, and your dashboard appears. For production, build your
frontend and keep the same `/api/erp` path — or set `window.MIPS_ERP_BASE` before loading
`mips-erp.js` if the API lives on another domain.

If you use **Next.js**, mount the proxy as a route handler:

```js
// app/api/erp/[...path]/route.js
import { createErpProxy } from '@/lib/server-plugin/erp-proxy.js';
const proxy = createErpProxy({ apiBase: process.env.MIPS_ERP_API_URL });

export async function GET(req, ctx)     { return proxy.handle(req); }
export async function POST(req, ctx)    { return proxy.handle(req); }
```

(Or just run `erp-proxy.js` on a small Express server beside Next — simplest.)

### 5b. Android app

In `app/build.gradle.kts`:

```kotlin
defaultConfig {
    buildConfigField("String", "API_BASE_URL", "\"https://your-backend.com\"")
}
```

Checklist:

- [ ] `ApiClient.kt` points at **your proxy**, not Render, not the ERP
- [ ] `TokenStore.init(this)` in `Application.onCreate()`
- [ ] `INTERNET` permission in the manifest
- [ ] Read timeout ≥ 75 s (login can take 2–10 s; cold start adds 30–60 s)
- [ ] Release build: `usesCleartextTraffic="false"`, logging set to `NONE`

Emulator tip: `localhost` inside the emulator is the emulator itself — use `10.0.2.2`
to reach a server on your dev machine.

---

## Step 6 — Keep it awake (optional)

Render's free instance sleeps after 15 min idle; the next request waits 30–60 s.

**Easiest:** free cron at <https://cron-job.org> → job that GETs
`https://YOUR-SERVICE.onrender.com/healthz` every **10 minutes**.

**Or** run the included script on anything always-on:

```bash
API_URL=https://YOUR-SERVICE.onrender.com sh keepalive.sh
```

**Or** GitHub Actions (`.github/workflows/keepalive.yml`, runs free on public repos):

```yaml
name: keepalive
on:
  schedule: [{ cron: '*/10 * * * *' }]
  workflow_dispatch:
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - run: curl -sf --max-time 30 "${{ secrets.API_URL }}/healthz" || true
```

Even with this, design your UI to survive a cold start — show
"The server is waking up…" rather than an endless spinner.

---

## Step 7 — Lock it down before real users

- [ ] **Change the ERP password** and update anything that stored the old one
- [ ] `CORS_ORIGIN` on Render → your exact web origin, not `*`
- [ ] Proxy served over HTTPS only
- [ ] Rate limiting on `/api/erp/login` (built in: 8 failures/IP/10 min → `429`)
- [ ] No ERP `apiKey` or password in any client bundle, APK, or Git history
- [ ] Session TTL suits you (default 20 min — matches the ERP's idle timeout)
- [ ] You understand: **never auto-retry a 401** — a wrong password makes the ERP
      e-mail the student their credentials and counts toward lockout

---

## Quick reference

### Local
```bash
npm install && npm start                              # API      :3000
node examples/webapp/serve.js                         # webapp   :4200
API_URL=http://localhost:3000 ERP_USER=… ERP_PASS=… node examples/smoke.mjs
node examples/test-peruser.mjs                        # per-user auth suite
```

### Production smoke test
```bash
API_URL=https://YOUR-SERVICE.onrender.com \
ERP_USER=2026BT0683 ERP_PASS='YOUR_NEW_PASS' \
node examples/smoke.mjs
```

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Render sets this automatically |
| `HOST` | `0.0.0.0` | must stay `0.0.0.0` in containers |
| `ERP_BASE_URL` | `https://erp.mpgi.net` | upstream portal |
| `ENABLE_OCR` | `true` | `false` → ~11 MB less RAM, manual captcha only |
| `OCR_RETRIES` | `15` | captcha attempts before falling back to manual |
| `MAX_SESSIONS` | `200` | set `50` on a 512 MB host |
| `SESSION_TTL_MS` | `1500000` | 25 min idle |
| `RATE_LIMIT` | `120` | requests/min per key |
| `CORS_ORIGIN` | `*` | set your origin in production |

### Everything in one picture

```
Android app ──┐
              ├──→ YOUR backend /api/erp ──→ Render: mips-erp-api ──→ erp.mpgi.net
Web app ──────┘     (opaque tokens)          (per-user sessions)
                      ↑
                      └── each user's own userId + password
```

---

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| `LoginStatus 5` but password is right | wrong institute id | pass `institute: "MIPS"` (MPEC is a different uuid) |
| Login always `CAPTCHA_FAILED` | OCR unlucky | use the manual captcha endpoint |
| Data endpoints return `[]` | session not primed | API does this at login; if you call `/v1/raw` directly, hit `/v1/auth/me` first |
| Account locked | retried a wrong password | wait for the ERP lockout to clear; stop retrying 401s |
| Android: `UnknownHostException` | emulator `localhost` | use `10.0.2.2` |
| Android: timeout on first call | Render cold start | raise timeout, show "waking up" |
| Web: CORS error | `CORS_ORIGIN` mismatch | set it to your exact origin and redeploy |
| Render OOM restarts | concurrent OCR | `ENABLE_OCR=false` |
