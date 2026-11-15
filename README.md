# VOX showtime agent

Watches **Dune: Part Three** and **Hadoota** at **VOX City Centre Almaza** (egy.voxcinemas.com) and sends an alert (ntfy push, Telegram and/or WhatsApp) when new showtimes appear. Runs on GitHub Actions every 15 minutes, around the clock.

## How it works
1. Playwright drives a real Google Chrome (under a virtual display on GitHub Actions) to open the VOX showtimes page. The site's Akamai bot protection blocks plain HTTP clients and Playwright's headless Chromium, so a real browser is needed.
2. For each movie in `MOVIES` (in the workflow), it loads every date tab at `city-centre-almaza` and collects each showtime's booking ID.
3. It compares them with that movie's `state-<movie>.json` and sends one alert (ntfy, Telegram and/or WhatsApp via CallMeBot) when:
   - a showtime ID appears that was never seen before (**🚨 NEW SHOWTIMES**). Greyed-out ones
     (sold out / not on sale yet) are included and marked *(not bookable yet)*;
   - a showtime that was greyed out becomes bookable for the first time (**🎟 BOOKING OPEN**).
     Each showtime only triggers this once, so seats opening and closing again don't re-alert.
4. When the set of showtimes changes, the workflow commits the updated state files back to the repo.
5. Once a day, the first successful check at or after **10:00 Cairo time** sends a short
   "✅ VOX agent is running" status message per movie to the same channels. If it stops arriving, the
   agent is broken (VOX blocking it, the workflow disabled, etc.). Change the hour with `HEARTBEAT_HOUR`.

### Staying on every 15 minutes
GitHub's own cron schedule is unreliable (it can skip runs for hours), so it isn't what drives
the checks. Instead each workflow run executes `run-loop.sh`: it checks all movies every 15
minutes for ~5h40m, then the last step starts the next run itself. The cron schedule (twice an
hour) is only a backup that restarts the chain if it ever breaks.

If VOX blocks the GitHub machine a run is on (HTTP 403), the run retries once after a minute,
then ends early so the next run starts on a fresh machine with a different IP. Repeated
failures back off to 5 and then 15 minutes between attempts.

You get an urgent alert if:
- checks keep failing for ~30 min ("can't check showtimes"), and another when they recover;
- the chain broke and had to be restarted ("agent was paused", with the time range missed).

The repo is public so Actions minutes are unlimited (a private repo's 2,000 free minutes a
month would run out). Phone numbers, keys and the ntfy topic are repo secrets and stay hidden.

**Testing:** Actions → *Check VOX showtimes* → Run workflow has test switches: `loop_minutes`
(short runs) and `test_failure` (sends a real "can't check" alert without checking VOX).

## One-time setup
Set up any of ntfy, Telegram or WhatsApp (CallMeBot). Every alert goes to all configured
channels, and a run only fails if none of them worked.

### ntfy (easiest: free, no account, push notifications)
1. Install the **ntfy** app (iOS / Android) and subscribe to your topic (server `ntfy.sh`).
   Anyone else who subscribes to the same topic gets the alerts too.
2. Repo secret: `NTFY_TOPIC`. Use a long random name, because anyone who knows it can read
   the alerts. Tapping an alert opens the VOX booking page.
3. New-showtime alerts are sent at ntfy's **urgent** priority (status messages are quiet).
   To make them impossible to miss:
   - **Android:** ntfy → Settings → turn on *Keep alerting for highest priority* (rings until
     you open it); in the topic's settings pick a loud custom sound; allow ntfy to override
     Do Not Disturb.
   - **iPhone:** Settings → Notifications → ntfy → allow *Time Sensitive Notifications* and
     *Critical Alerts* if offered, banner style *Persistent*; add ntfy to your Focus modes'
     allowed apps.

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

Secrets live in Settings → Secrets and variables → Actions.

## Watching another movie
1. Find its slug: open the VOX showtimes page, pick the movie, and copy the `m=` value from the URL
   (e.g. `hadoota-arabic` in `...showtimes?c=city-centre-almaza&m=hadoota-arabic`).
2. Add it to `MOVIES` in `.github/workflows/check.yml` (space-separated).
3. Its first check saves the current showtimes silently; alerts start from the next new one.
   The change takes effect when the current run hands over to the next (within ~6 hours), or
   cancel the running workflow run and start a new one to apply it now.

## Run locally
```bash
npm ci
BROWSER_CHANNEL=chrome DRY_RUN=1 node check-showtimes.js                 # prints the alert instead of sending
BROWSER_CHANNEL=chrome CALLMEBOT_PHONE=+20... CALLMEBOT_APIKEY=... node check-showtimes.js
```
To watch a different movie or branch, set `MOVIE_SLUG` / `CINEMA_SLUG` (e.g. `mall-of-egypt`).
Delete a movie's `state-<movie>.json` to reset its baseline. Set `ALERT_ON_FIRST_RUN=1` to also get the current list on the first run.

## Notes
- GitHub disables scheduled workflows after 60 days with no repo activity. The daily status message saves a commit each day, which keeps the repo active.
- VOX's bot protection could start blocking GitHub's IPs (`ERR_HTTP2_PROTOCOL_ERROR`). You'd get the "can't check" alert.
- GitHub's Actions terms discourage always-on jobs; if GitHub ever disables the workflow, the daily status messages stop.
