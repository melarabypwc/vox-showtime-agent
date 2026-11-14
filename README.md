# VOX showtime agent

Watches **Dune: Part Three** at **VOX City Centre Almaza** (egy.voxcinemas.com) and sends a WhatsApp message when new showtimes appear. Runs on GitHub Actions every 15 minutes.

## How it works
1. Playwright drives a real Google Chrome (under a virtual display on GitHub Actions) to open the VOX showtimes page. The site's Akamai bot protection blocks plain HTTP clients and Playwright's headless Chromium, so a real browser is needed.
2. It loads every date tab for `dune-part-three` at `city-centre-almaza` and collects each showtime's booking ID.
3. It compares them with `state.json`. Any ID not seen before triggers one WhatsApp message via CallMeBot, listing the new dates, times and formats (IMAX, Standard, …).
4. When the set of showtimes changes, the workflow commits the updated `state.json` back to the repo.

## One-time setup
1. **CallMeBot key**: add `+34 644 66 32 62` to your contacts and send it the WhatsApp message
   `I allow callmebot to send me messages`. It replies with your API key.
   (If that number changed, check https://www.callmebot.com/blog/free-api-whatsapp-messages/.)
2. **Repo secrets** (Settings → Secrets and variables → Actions):
   - `CALLMEBOT_PHONE`: your number with country code, e.g. `+2010xxxxxxxx`
   - `CALLMEBOT_APIKEY`: the key from step 1
3. Push this folder to a GitHub repo. Then go to Actions → *Check Dune showtimes* → **Run workflow** once to test.

## Run locally
```bash
npm ci
BROWSER_CHANNEL=chrome DRY_RUN=1 node check-showtimes.js                 # prints the alert instead of sending
BROWSER_CHANNEL=chrome CALLMEBOT_PHONE=+20... CALLMEBOT_APIKEY=... node check-showtimes.js
```
To watch a different movie or branch, set `MOVIE_SLUG` / `CINEMA_SLUG` (e.g. `mall-of-egypt`).
Delete `state.json` to reset the baseline. Set `ALERT_ON_FIRST_RUN=1` to also get the current list on the first run.

## Notes
- GitHub's cron is best-effort and can run late during busy periods.
- GitHub disables scheduled workflows after 60 days with no repo activity. State commits only happen when showtimes change, so re-enable the workflow if it stops.
- VOX's bot protection could start blocking GitHub's IPs (`ERR_HTTP2_PROTOCOL_ERROR`). If runs keep failing, run it on your Mac instead (cron/launchd).
