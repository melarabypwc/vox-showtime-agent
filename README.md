# VOX showtime agent

Watches **Dune: Part Three** at **VOX City Centre Almaza** (egy.voxcinemas.com) and sends an alert (ntfy push, Telegram and/or WhatsApp) when new showtimes appear. Runs on GitHub Actions every 15 minutes.

## How it works
1. Playwright drives a real Google Chrome (under a virtual display on GitHub Actions) to open the VOX showtimes page. The site's Akamai bot protection blocks plain HTTP clients and Playwright's headless Chromium, so a real browser is needed.
2. It loads every date tab for `dune-part-three` at `city-centre-almaza` and collects each showtime's booking ID.
3. It compares them with `state.json`. Any ID not seen before triggers one alert (ntfy, Telegram and/or WhatsApp via CallMeBot), listing the new dates, times and formats (IMAX, Standard, …).
4. When the set of showtimes changes, the workflow commits the updated `state.json` back to the repo.

## One-time setup
Set up any of ntfy, Telegram or WhatsApp (CallMeBot). Every alert goes to all configured
channels, and a run only fails if none of them worked.

### ntfy (easiest: free, no account, push notifications)
1. Install the **ntfy** app (iOS / Android) and subscribe to your topic (server `ntfy.sh`).
   Anyone else who subscribes to the same topic gets the alerts too.
2. Repo secret: `NTFY_TOPIC`. Use a long random name, because anyone who knows it can read
   the alerts. Tapping an alert opens the VOX booking page.

### Telegram (reliable, free, works in groups)
1. In Telegram, message **@BotFather**, send `/newbot`, pick a name and username. It gives you a **token**.
2. Send your new bot any message. For a group, add the bot to the group and send `/start` there.
3. Find the chat ID (this also sends a test message):
   ```bash
   TELEGRAM_BOT_TOKEN=123456:ABC... node telegram-setup.js
   ```
4. Repo secrets: `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` (comma-separate several chats;
   group IDs start with `-`).

### WhatsApp via CallMeBot (free, but delivery can be slow or flaky)
1. Add `+34 698 28 89 73` to your contacts and send it the WhatsApp message
   `I allow callmebot to send me messages`. It replies with your API key within ~2 minutes;
   if not, CallMeBot says to wait 24h before trying again.
   The bot number changes from time to time; the current one is always on
   https://www.callmebot.com/blog/free-api-whatsapp-messages/.
2. Repo secrets:
   - `CALLMEBOT_PHONE`: your number with country code, e.g. `+2010xxxxxxxx`
   - `CALLMEBOT_APIKEY`: the key from step 1
   - `CALLMEBOT_RECIPIENTS` (optional): more people to alert, as `+2010xxxx:key1,+2011xxxx:key2`.
     Each person does step 1 on their own phone to get their own key. CallMeBot's free API
     can't post into a WhatsApp group, so this sends each person the alert individually.

Secrets live in Settings → Secrets and variables → Actions. Then go to Actions →
*Check Dune showtimes* → **Run workflow** once to test.

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
