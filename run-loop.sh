#!/usr/bin/env bash
# Runs inside one GitHub Actions job: checks every movie every 15 minutes for ~5h40m,
# saving state after each round. The workflow then starts the next job, so checks never stop.
#
# If VOX blocks this machine (HTTP 403 etc.), it retries once, then ends the run early so the
# next run starts on a fresh GitHub machine with a different IP. The failure count is passed
# to the next run (PRIOR_FAILURES / FIRST_FAIL_TS) so it can back off and alert.
#
# Alerts you if:
#   - checks keep failing for ~30 min ("can't check showtimes"), and again when they recover
#   - the previous run ended long before this one started ("agent was paused")
set -u

MOVIES=${MOVIES:-"dune-part-three hadoota-arabic"}
INTERVAL=${INTERVAL_SECONDS:-900}         # 15 min
DURATION=${LOOP_SECONDS:-20400}           # 5h40m, under GitHub's 6h job limit
FAIL_ALERT_AFTER=${FAIL_ALERT_AFTER:-4}   # consecutive failed attempts before alerting
RETRY_WAIT=${RETRY_WAIT_SECONDS:-60}

fails=${PRIOR_FAILURES:-0}
[[ "$fails" =~ ^[0-9]+$ ]] || fails=0
first_fail=${FIRST_FAIL_TS:-0}
[[ "$first_fail" =~ ^[0-9]+$ ]] || first_fail=0

alert() { node check-showtimes.js --alert "$1" || echo "Could not send alert: $1"; }
cairo() { TZ=Africa/Cairo date -d "@$1" '+%a %d %b %H:%M'; }

# Hand the failure count to the "Start next run" step.
handoff() {
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "NEXT_PRIOR_FAILURES=$fails" >>"$GITHUB_ENV"
    echo "NEXT_FIRST_FAIL_TS=$first_fail" >>"$GITHUB_ENV"
  fi
}

# --- Was there a gap since the last check? ---
last_end=$(gh run list --workflow check.yml --status completed --limit 5 --json updatedAt,conclusion \
  --jq '[.[] | select(.conclusion=="success" or .conclusion=="failure")][0].updatedAt // empty' 2>/dev/null)
if [ -n "$last_end" ] && [ "${SKIP_GAP_ALERT:-false}" != "true" ]; then
  last_ts=$(date -d "$last_end" +%s)
  gap=$(( $(date +%s) - last_ts ))
  echo "Previous run ended $(cairo "$last_ts") Cairo, ${gap}s ago."
  if [ "$gap" -gt "${GAP_ALERT_SECONDS:-2700}" ]; then  # 45 min
    alert "⚠️ VOX agent was paused
No checks ran from $(cairo "$last_ts") to $(cairo "$(date +%s)") Cairo time (GitHub stopped the run).
It has restarted itself and is checking again."
  fi
fi

# --- Back off if previous runs kept failing (VOX down, not just one blocked machine) ---
if [ "$fails" -ge 3 ]; then backoff=$INTERVAL
elif [ "$fails" -eq 2 ]; then backoff=300
else backoff=0; fi
if [ "$backoff" -gt 0 ]; then
  echo "$fails failed attempts so far; waiting ${backoff}s before trying."
  sleep "$backoff"
fi

save_state() {
  git add -A -- 'state-*.json'
  if ! git diff --cached --quiet; then
    git commit -q -m "Update showtimes state"
    for i in 1 2 3; do
      git pull -q --rebase && git push -q && return 0
      sleep 5
    done
    echo "Could not push state"
  fi
}

check_all() {
  local ok=1
  for m in $MOVIES; do
    MOVIE_SLUG=$m xvfb-run --auto-servernum node check-showtimes.js || ok=0
  done
  save_state
  [ "$ok" = 1 ]
}

END=$(( $(date +%s) + DURATION ))
round=0
while :; do
  round=$((round + 1))
  start=$(date +%s)
  echo "::group::Round $round at $(cairo "$start") Cairo"
  if check_all; then ok=1; else
    echo "Round $round failed; retrying in ${RETRY_WAIT}s"
    sleep "$RETRY_WAIT"
    if check_all; then ok=1; else ok=0; fi
  fi
  echo "::endgroup::"

  if [ "$ok" = 1 ]; then
    if [ "$fails" -ge "$FAIL_ALERT_AFTER" ]; then
      alert "✅ VOX agent recovered
Checks are working again as of $(cairo "$(date +%s)") Cairo time."
    fi
    fails=0
    first_fail=0
  else
    fails=$((fails + 1))
    [ "$first_fail" = 0 ] && first_fail=$start
    echo "Round $round failed after retry ($fails failed attempts in a row)."
    if [ "$fails" -eq "$FAIL_ALERT_AFTER" ]; then
      alert "⚠️ VOX agent can't check showtimes
Checks have been failing since about $(cairo "$first_fail") Cairo time. It keeps retrying on fresh machines; you'll get a message when it recovers.
Meanwhile check manually: https://egy.voxcinemas.com/showtimes?c=city-centre-almaza"
    fi
    echo "Ending this run early so the next one starts on a fresh machine (new IP)."
    handoff
    exit 0
  fi

  next=$(( start + INTERVAL ))
  [ "$next" -ge "$END" ] && break
  sleep $(( next - $(date +%s) > 0 ? next - $(date +%s) : 0 ))
done
handoff
echo "Loop finished after $round rounds."
