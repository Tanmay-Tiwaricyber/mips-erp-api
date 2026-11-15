#!/usr/bin/env sh
# keepalive.sh — stop Render's free instance from going cold.
#
# Render sleeps a free web service after 15 minutes with no inbound traffic.
# The next request then waits 30-60 s while the container boots. Ping /healthz
# every 10 minutes from any always-on machine to keep it warm.
#
# Options (in order of effort):
#   1. A free external cron: https://cron-job.org  → GET https://YOUR-API.onrender.com/healthz every 10 min
#   2. This script on a VPS / Raspberry Pi / old laptop:
#        nohup sh keepalive.sh > keepalive.log 2>&1 &
#   3. GitHub Actions on a schedule (see .github/workflows/keepalive.yml)
#
# Usage:  API_URL=https://your-api.onrender.com sh keepalive.sh
#         API_URL=... INTERVAL=600 sh keepalive.sh

API_URL="${API_URL:-http://localhost:3000}"
INTERVAL="${INTERVAL:-600}"   # seconds (10 min — under Render's 15 min idle timer)

echo "keepalive: pinging ${API_URL}/healthz every ${INTERVAL}s (Ctrl-C to stop)"

while true; do
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  code=$(curl -s -o /dev/null -m 30 -w '%{http_code}' "${API_URL}/healthz" 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo "$ts  ok  $code"
  else
    echo "$ts  !!  $code (service may be waking — next ping will tell)"
  fi
  sleep "$INTERVAL"
done
