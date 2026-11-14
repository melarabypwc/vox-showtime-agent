// Checks VOX Cinemas Egypt for new showtimes of a movie at one cinema,
// and sends ntfy, Telegram and/or WhatsApp (CallMeBot) alerts when new ones appear.
//
// Env vars:
//   CALLMEBOT_PHONE   your WhatsApp number with country code, e.g. +2010xxxxxxxx
//   CALLMEBOT_APIKEY  the key CallMeBot sent you
//   CALLMEBOT_RECIPIENTS  optional extra people, "+2010xxxx:key1,+2011xxxx:key2"
//   TELEGRAM_BOT_TOKEN    token from @BotFather
//   TELEGRAM_CHAT_ID      chat id(s) to alert, comma-separated (people or groups)
//   NTFY_TOPIC            ntfy.sh topic to push to (NTFY_SERVER to self-host)
//   MOVIE_SLUG        default: dune-part-three
//   CINEMA_SLUG       default: city-centre-almaza
//   DRY_RUN=1         print the alert instead of sending it
//   HEARTBEAT_HOUR    Cairo hour for the daily "agent is running" message (default 10)

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = 'https://egy.voxcinemas.com';
const MOVIE = process.env.MOVIE_SLUG || 'dune-part-three';
const CINEMA = process.env.CINEMA_SLUG || 'city-centre-almaza';
const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null; // first run
  }
}

// "Today" / "Tomorrow" / "Thu 17 Dec" -> "20261217"
function labelToDate(label, todayYmd) {
  const today = new Date(`${todayYmd.slice(0, 4)}-${todayYmd.slice(4, 6)}-${todayYmd.slice(6, 8)}T12:00:00Z`);
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  if (/^today/i.test(label)) return todayYmd;
  if (/^tomorrow/i.test(label)) return ymd(new Date(today.getTime() + 86400000));
  const m = label.match(/(\d{1,2})\s+([A-Za-z]{3})/);
  if (!m) return todayYmd;
  const month = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2].toLowerCase()) / 3;
  let year = today.getUTCFullYear();
  if (month < today.getUTCMonth()) year += 1; // e.g. a January date seen in December
  return ymd(new Date(Date.UTC(year, month, Number(m[1]), 12)));
}

async function scrape() {
  // BROWSER_CHANNEL=chrome uses your installed Google Chrome instead of Playwright's Chromium.
  const browser = await chromium.launch({
    headless: !process.env.HEADED, // HEADED=1 runs a visible window (use xvfb-run on Linux)
    channel: process.env.BROWSER_CHANNEL || undefined,
    args: ['--disable-blink-features=AutomationControlled'], // VOX's Akamai bot check rejects the automation flag
  });
  try {
    const context = await browser.newContext({
      // The default headless UA contains "HeadlessChrome", which is blocked.
      userAgent:
        process.platform === 'darwin'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
          : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
    });
    const page = await context.newPage();
    const startUrl = `${BASE}/showtimes?c=${CINEMA}&m=${MOVIE}`;
    const resp = await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!resp || resp.status() >= 400) throw new Error(`VOX returned HTTP ${resp && resp.status()}`);
    await page.waitForTimeout(5000); // let the bot-protection script set its cookies before navigating on

    // Collect the date tabs, then open each one as a normal page load.
    const dates = await page.evaluate(() => {
      const ds = [...document.querySelectorAll('a[href*="/showtimes"]')]
        .map((a) => new URL(a.href, location.href).searchParams.get('d'))
        .filter(Boolean);
      return [...new Set(ds)];
    });

    const parse = (movie) => {
      const out = [];
      document.querySelectorAll(`article.movie-compare[data-slug="${movie}"]`).forEach((art) => {
        art.querySelectorAll('ol.showtimes > li').forEach((fmtLi) => {
          const format = fmtLi.querySelector('strong')?.textContent.trim() || 'Standard';
          fmtLi.querySelectorAll('a.showtime').forEach((a) => {
            out.push({ id: a.dataset.id, format, time: a.textContent.trim(), url: a.href });
          });
        });
      });
      return out;
    };

    // The undated page shows whichever date tab is selected (a <span>, not a link).
    const todayCairo = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }).replace(/-/g, '');
    const selectedLabel = await page.evaluate(() => {
      const link = document.querySelector('a[href*="/showtimes"][href*="d="]');
      return link?.closest('ol')?.querySelector('li > span')?.textContent.trim() || 'Today';
    });
    const selectedDate = labelToDate(selectedLabel, todayCairo);
    const all = (await page.evaluate(parse, MOVIE)).map((s) => ({ ...s, date: selectedDate }));

    for (const d of dates) {
      const r = await page.goto(`${startUrl}&d=${d}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!r || r.status() >= 400) throw new Error(`VOX returned HTTP ${r && r.status()} for date ${d}`);
      all.push(...(await page.evaluate(parse, MOVIE)).map((s) => ({ ...s, date: d })));
      await page.waitForTimeout(1500 + Math.random() * 1500); // be polite
    }
    // The undated page can fall back to the first date that has shows; let explicit dates win.
    const byId = new Map();
    for (const st of all) byId.set(st.id, st);
    const title = await page.evaluate(
      (m) => document.querySelector(`article.movie-compare[data-slug="${m}"] h2`)?.textContent.trim(),
      MOVIE
    );
    return { dates: [selectedDate, ...dates], showtimes: [...byId.values()], title };
  } finally {
    await browser.close();
  }
}

function fmtDate(d) {
  const dt = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00Z`);
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function buildMessage(newOnes, title) {
  const byDate = {};
  for (const s of newOnes) (byDate[s.date] ||= []).push(s);
  const cinema = CINEMA.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const lines = [`🎬 New ${title || MOVIE} showtimes at VOX ${cinema}:`];
  for (const d of Object.keys(byDate).sort()) {
    const parts = byDate[d].map((s) => `${s.time} (${s.format})`).join(', ');
    lines.push(`• ${fmtDate(d)}: ${parts}`);
  }
  lines.push(`Book: ${BASE}/showtimes?c=${CINEMA}&m=${MOVIE}`);
  return lines.join('\n');
}

// Everyone gets their own CallMeBot key (the free API can only message the number that
// activated it). CALLMEBOT_RECIPIENTS adds more people: "+2010xxxx:key1,+2011xxxx:key2".
function recipients() {
  const list = [];
  if (process.env.CALLMEBOT_PHONE && process.env.CALLMEBOT_APIKEY) {
    list.push({ phone: process.env.CALLMEBOT_PHONE.trim(), apikey: process.env.CALLMEBOT_APIKEY.trim() });
  }
  for (const entry of (process.env.CALLMEBOT_RECIPIENTS || '').split(/[,\n]/)) {
    const [phone, apikey] = entry.split(':').map((x) => x && x.trim());
    if (phone && apikey) list.push({ phone, apikey });
  }
  return list;
}

// Returns how many WhatsApp recipients CallMeBot accepted.
async function sendWhatsApp(text) {
  let sent = 0;
  for (const { phone, apikey } of recipients()) {
    const masked = phone.slice(0, 4) + '…' + phone.slice(-3);
    try {
      const url = 'https://api.callmebot.com/whatsapp.php?' + new URLSearchParams({ phone, apikey, text });
      const r = await fetch(url);
      const body = await r.text();
      if (!r.ok || /error|invalid/i.test(body.slice(0, 500))) throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
      console.log(`WhatsApp alert queued for ${masked}.`);
      sent++;
    } catch (e) {
      console.error(`CallMeBot failed for ${masked}: ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 2000)); // CallMeBot rate-limits rapid calls
  }
  return sent;
}

// TELEGRAM_CHAT_ID can list several chats (people or groups), comma-separated.
// Returns how many chats Telegram delivered to.
async function sendTelegram(text) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chats = (process.env.TELEGRAM_CHAT_ID || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!token || !chats.length) return 0;
  let sent = 0;
  for (const chat_id of chats) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text, disable_web_page_preview: true }),
      });
      const body = await r.json();
      if (!body.ok) throw new Error(`${r.status}: ${body.description}`);
      console.log(`Telegram alert sent to chat ${chat_id}.`);
      sent++;
    } catch (e) {
      console.error(`Telegram failed for chat ${chat_id}: ${e.message}`);
    }
  }
  return sent;
}

// ntfy.sh push notifications: no account needed, just subscribe to the topic in the ntfy app.
// Returns 1 if delivered, 0 if not configured or failed.
async function sendNtfy(text, opts = {}) {
  const topic = (process.env.NTFY_TOPIC || '').trim();
  if (!topic) return 0;
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const [first, ...rest] = text.split('\n');
  try {
    const r = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        title: first.replace(/^(🎬|✅)\s*/, ''),
        message: rest.join('\n') || first,
        tags: opts.tags || ['movie_camera'],
        priority: opts.priority || 4,
        click: `${BASE}/showtimes?c=${CINEMA}&m=${MOVIE}`,
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    console.log('ntfy alert sent.');
    return 1;
  } catch (e) {
    console.error(`ntfy failed: ${e.message}`);
    return 0;
  }
}

async function notify(text, opts = {}) {
  if (process.env.DRY_RUN) {
    console.log('--- DRY RUN, would send ---\n' + text);
    return;
  }
  const hasTelegram = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
  if (!recipients().length && !hasTelegram && !process.env.NTFY_TOPIC) {
    throw new Error('No alert channel configured: set NTFY_TOPIC, TELEGRAM_* and/or CALLMEBOT_* secrets');
  }
  const sent = (await sendNtfy(text, opts)) + (await sendTelegram(text)) + (await sendWhatsApp(text));
  // Fail only if nobody got it, so the run retries next time instead of losing the alert.
  if (!sent) throw new Error('Every alert channel failed');
}

// Cairo-local date and hour (handles Egypt's daylight saving time).
function cairoNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const HEARTBEAT_HOUR = Number(process.env.HEARTBEAT_HOUR || 10); // Cairo time

function buildHeartbeat(showtimes, title, newCount) {
  const upcoming = showtimes.filter((s) => s.date >= cairoNow().date.replace(/-/g, ''));
  const days = [...new Set(upcoming.map((s) => s.date))].sort();
  const cinema = CINEMA.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const lines = [`✅ VOX agent is running`];
  lines.push(`Watching ${title || MOVIE} at VOX ${cinema}.`);
  // "28 upcoming IMAX showtimes" for one format, "40 upcoming showtimes (28 IMAX, 12 Standard)" for several.
  const byFormat = {};
  for (const s of upcoming) byFormat[s.format] = (byFormat[s.format] || 0) + 1;
  const formats = Object.entries(byFormat).sort((a, b) => b[1] - a[1]);
  const what =
    formats.length === 1
      ? `${upcoming.length} upcoming ${formats[0][0]} showtimes`
      : `${upcoming.length} upcoming showtimes (${formats.map(([f, n]) => `${n} ${f}`).join(', ')})`;
  lines.push(
    days.length
      ? `${what} on ${days.length} day(s): ${fmtDate(days[0])} to ${fmtDate(days[days.length - 1])}.`
      : 'No upcoming showtimes listed right now.'
  );
  if (newCount) lines.push(`${newCount} new showtime(s) found in this check (alert sent separately).`);
  lines.push('Checks every 15 minutes. If this message stops arriving, the agent needs attention.');
  return lines.join('\n');
}

(async () => {
  const prev = loadState();
  const { dates, showtimes, title } = await scrape();
  console.log(`Checked ${dates.length} dates, found ${showtimes.length} showtimes for ${MOVIE}.`);

  const prevIds = new Set((prev?.showtimes || []).map((s) => s.id));
  const newOnes = showtimes.filter((s) => !prevIds.has(s.id));

  if (!prev) {
    console.log('First run: saving baseline.');
    if (process.env.ALERT_ON_FIRST_RUN && showtimes.length) await notify(buildMessage(showtimes, title));
  } else if (newOnes.length) {
    console.log(`${newOnes.length} new showtime(s).`);
    await notify(buildMessage(newOnes, title));
  } else {
    console.log('No new showtimes.');
  }

  // Once a day after HEARTBEAT_HOUR (Cairo), confirm the agent is alive. Any run from 10:00 on
  // can send it, so a late GitHub schedule still delivers it, just a bit after 10.
  let lastHeartbeat = prev?.lastHeartbeat;
  const now = cairoNow();
  if (now.hour >= HEARTBEAT_HOUR && lastHeartbeat !== now.date) {
    try {
      await notify(buildHeartbeat(showtimes, title, newOnes.length), { priority: 2, tags: ['white_check_mark'] });
      lastHeartbeat = now.date;
      console.log('Daily status message sent.');
    } catch (e) {
      console.error(`Daily status message failed, will retry next run: ${e.message}`);
    }
  }

  // Keep previously-seen past showtimes too, so they never re-trigger.
  const merged = new Map((prev?.showtimes || []).map((s) => [s.id, s]));
  for (const s of showtimes) merged.set(s.id, s);
  const sorted = [...merged.values()].sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
  // Only rewrite the file when the set of showtimes changed, so the repo isn't committed to every run.
  if (!prev || JSON.stringify(prev.showtimes) !== JSON.stringify(sorted) || prev.lastHeartbeat !== lastHeartbeat) {
    const state = { updatedAt: new Date().toISOString(), lastHeartbeat, showtimes: sorted };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
