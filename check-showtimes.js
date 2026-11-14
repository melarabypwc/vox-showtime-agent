// Checks VOX Cinemas Egypt for new showtimes of a movie at one cinema,
// and sends a WhatsApp alert (via CallMeBot) when new ones appear.
//
// Env vars:
//   CALLMEBOT_PHONE   your WhatsApp number with country code, e.g. +2010xxxxxxxx
//   CALLMEBOT_APIKEY  the key CallMeBot sent you
//   CALLMEBOT_RECIPIENTS  optional extra people, "+2010xxxx:key1,+2011xxxx:key2"
//   MOVIE_SLUG        default: dune-part-three
//   CINEMA_SLUG       default: city-centre-almaza
//   DRY_RUN=1         print the alert instead of sending it

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

async function sendWhatsApp(text) {
  if (process.env.DRY_RUN) {
    console.log('--- DRY RUN, would send ---\n' + text);
    return;
  }
  const people = recipients();
  if (!people.length) throw new Error('Set CALLMEBOT_PHONE + CALLMEBOT_APIKEY and/or CALLMEBOT_RECIPIENTS');
  let sent = 0;
  for (const { phone, apikey } of people) {
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
  // Fail only if nobody got it, so the run retries next time instead of losing the alert.
  if (!sent) throw new Error('CallMeBot failed for every recipient');
}

(async () => {
  const prev = loadState();
  const { dates, showtimes, title } = await scrape();
  console.log(`Checked ${dates.length} dates, found ${showtimes.length} showtimes for ${MOVIE}.`);

  const prevIds = new Set((prev?.showtimes || []).map((s) => s.id));
  const newOnes = showtimes.filter((s) => !prevIds.has(s.id));

  if (!prev) {
    console.log('First run: saving baseline.');
    if (process.env.ALERT_ON_FIRST_RUN && showtimes.length) await sendWhatsApp(buildMessage(showtimes, title));
  } else if (newOnes.length) {
    console.log(`${newOnes.length} new showtime(s).`);
    await sendWhatsApp(buildMessage(newOnes, title));
  } else {
    console.log('No new showtimes.');
  }

  // Keep previously-seen past showtimes too, so they never re-trigger.
  const merged = new Map((prev?.showtimes || []).map((s) => [s.id, s]));
  for (const s of showtimes) merged.set(s.id, s);
  const sorted = [...merged.values()].sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
  // Only rewrite the file when the set of showtimes changed, so the repo isn't committed to every run.
  if (!prev || JSON.stringify(prev.showtimes) !== JSON.stringify(sorted)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), showtimes: sorted }, null, 2) + '\n');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
