#!/usr/bin/env bash
# Runs inside one GitHub Actions job: checks every movie every 15 minutes for ~5h40m,
# saving state after each round. The workflow then starts the next job, so checks never stop.
#
# Also alerts you if:
#   - checks fail for an hour straight (VOX blocking, site changed, ...)
#   - the previous job ended long before this one started (the chain broke and the
#     GitHub schedule had to restart it)
set -u

MOVIES=${MOVIES:-"dune-part-three hadoota-arabic"}
INTERVAL=${INTERVAL_SECONDS:-900}       # 15 min
DURATION=${LOOP_SECONDS:-20400}         # 5h40m, under GitHub's 6h job limit
FAIL_ALERT_AFTER=${FAIL_ALERT_AFTER:-4} # consecutive failed rounds (= 1 hour)

END=$(( $(date +%s) + DURATION ))
fails=0

alert() { node check-showtimes.js --alert "$1" || echo "Could not send alert: $1"; }
cairo() { TZ=Africa/Cairo date -d "@$1" '+%a %d %b %H:%M'; }

# --- Was there a gap since the last check? ---
last_end=$(gh run list --workflow check.yml --status completed --limit 5 --json updatedAt,conclusion \
  --jq '[.[] | select(.conclusion=="success" or .conclusion=="failure")][0].updatedAt // empty' 2>/dev/null)
if [ -n "$last_end" ] && [ "${SKIP_GAP_ALERT:-false}" != "true" ]; then
  last_ts=$(date -d "$last_end" +%s)
  gap=$(( $(date +%s) - last_ts ))
  if [ "$gap" -gt 2700 ]; then  # 45 min
    alert "⚠️ VOX agent was paused
No checks ran from $(cairo "$last_ts") to $(cairo "$(date +%s)") Cairo time (GitHub stopped the run).
It has restarted itself and is checking again."
  fi
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

round=0
while :; do
  round=$((round + 1))
  start=$(date +%s)
  echo "::group::Round $round at $(cairo "$start") Cairo"
  ok=1
  for m in $MOVIES; do
    MOVIE_SLUG=$m xvfb-run --auto-servernum node check-showtimes.js || ok=0
  done
  save_state
  echo "::endgroup::"

  if [ "$ok" = 1 ]; then
    if [ "$fails" -ge "$FAIL_ALERT_AFTER" ]; then
      alert "✅ VOX agent recovered
Checks are working again as of $(cairo "$(date +%s)") Cairo time."
    fi
    fails=0
  else
    fails=$((fails + 1))
    echo "Round $round had failures ($fails in a row)"
    if [ "$fails" -eq "$FAIL_ALERT_AFTER" ]; then
      alert "⚠️ VOX agent can't check showtimes
Checks have failed for the last hour (since about $(cairo $(( start - (FAIL_ALERT_AFTER - 1) * INTERVAL ))) Cairo time). It keeps retrying every 15 min; you'll get a message when it recovers.
Meanwhile check manually: https://egy.voxcinemas.com/showtimes?c=city-centre-almaza"
    fi
  fi

  next=$(( start + INTERVAL ))
  [ "$next" -ge "$END" ] && break
  sleep $(( next - $(date +%s) > 0 ? next - $(date +%s) : 0 ))
done
echo "Loop finished after $round rounds."
