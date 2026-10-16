"use strict";
// The practice calendar. A visit's `day` counts calendar days from today: 0 is today, 1 tomorrow, 7 the same
// weekday next week. A demo's "today" is always Monday 12 October 2026; a live practice uses the UK date, and its
// stored day numbers move back by one each midnight (see roll). Weekends, bank holidays and the practice's own
// closure dates are closed.
const sandbox = require("./sandbox");

const DEMO_TODAY = "2026-10-12";
const DAY_MS = 864e5;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Bank holidays in England and Wales (gov.uk). Extend each year; the office can add its own closures in Settings.
const BANK_HOLIDAYS = {
  "2026-01-01": "New Year's Day", "2026-04-03": "Good Friday", "2026-04-06": "Easter Monday", "2026-05-04": "Early May bank holiday",
  "2026-05-25": "Spring bank holiday", "2026-08-31": "Summer bank holiday", "2026-12-25": "Christmas Day", "2026-12-28": "Boxing Day (substitute day)",
  "2027-01-01": "New Year's Day", "2027-03-26": "Good Friday", "2027-03-29": "Easter Monday", "2027-05-03": "Early May bank holiday",
  "2027-05-31": "Spring bank holiday", "2027-08-30": "Summer bank holiday", "2027-12-27": "Christmas Day (substitute day)", "2027-12-28": "Boxing Day (substitute day)",
  "2028-01-03": "New Year's Day (substitute day)", "2028-04-14": "Good Friday", "2028-04-17": "Easter Monday", "2028-05-01": "Early May bank holiday",
  "2028-05-29": "Spring bank holiday", "2028-08-28": "Summer bank holiday", "2028-12-25": "Christmas Day", "2028-12-26": "Boxing Day",
};

const LONDON_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
const londonToday = (ms = Date.now()) => LONDON_DATE.format(ms); // YYYY-MM-DD

/** The sandbox in context, if any. Pure functions (tests of the ranking) run outside one and get the demo calendar. */
const here = () => { try { return sandbox.current(); } catch { return null; } };
const todayISO = (sb = here()) => (sb && sb.live ? londonToday() : DEMO_TODAY);
const utc = (iso) => Date.parse(iso + "T00:00:00Z");

const dateOf = (day, sb = here()) => new Date(utc(todayISO(sb)) + day * DAY_MS);
const iso = (day, sb = here()) => dateOf(day, sb).toISOString().slice(0, 10);
/** 0 = Monday … 6 = Sunday. */
const weekday = (day, sb = here()) => (dateOf(day, sb).getUTCDay() + 6) % 7;
/** The day number of a date (YYYY-MM-DD), relative to today. */
const dayOf = (isoDate, sb = here()) => Math.round((utc(String(isoDate).slice(0, 10)) - utc(todayISO(sb))) / DAY_MS);

const closures = (sb = here()) => (sb && sb.settings && Array.isArray(sb.settings.closures) ? sb.settings.closures : []);
/** Why the practice is shut that day, or null when it's open. */
function closedWhy(day, sb = here()) {
  const w = weekday(day, sb);
  if (w >= 5) return WEEKDAYS[w];
  const d = iso(day, sb);
  if (BANK_HOLIDAYS[d]) return BANK_HOLIDAYS[d];
  const own = closures(sb).find((c) => (c.date || c) === d);
  return own ? (own.reason || "Practice closed") : null;
}
const isOpen = (day, sb = here()) => !closedWhy(day, sb);

/** "Mon 12 Oct" */
const label = (day, sb = here()) => { const d = dateOf(day, sb); return `${WEEKDAYS[weekday(day, sb)].slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`; };
/** "Monday 12 October" */
const longLabel = (day, sb = here()) => { const d = dateOf(day, sb); return `${WEEKDAYS[weekday(day, sb)]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
/** How a text refers to a day: "today", "tomorrow", "on Wednesday 14 Oct". */
const phrase = (day, sb = here()) => (day === 0 ? "today" : day === 1 ? "tomorrow" : `on ${WEEKDAYS[weekday(day, sb)]} ${label(day, sb).slice(4)}`);

/** How far ahead each kind of booking may go, in days (Settings: bookAheadDays, onlineAheadDays, offerAheadDays). */
const ahead = (key, sb = here()) => {
  const fallback = { bookAheadDays: 365, onlineAheadDays: 42, offerAheadDays: 14 }[key];
  const v = sb && sb.settings ? Number(sb.settings[key]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** The next `count` open days from `from`, no further than `max` days ahead. */
function openDays(from = 0, count = 5, max = ahead("bookAheadDays"), sb = here()) {
  const out = [];
  for (let d = Math.max(0, from); d <= max && out.length < count; d++) if (isOpen(d, sb)) out.push(d);
  return out;
}

/** Working minutes from now until a visit (day, start): closed days don't count. PCSE's 48 hours exclude weekends
 *  and bank holidays. */
function workMinutesUntil(day, start, now, sb = here()) {
  if (day < 0 || (day === 0 && start <= now)) return start - now + day * 1440;
  let m = 0;
  for (let d = 0; d <= day; d++) {
    if (!isOpen(d, sb)) continue;
    const from = d === 0 ? now : 0, to = d === day ? start : 1440;
    m += Math.max(0, to - from);
  }
  return m;
}

/** The earliest start (minutes after midnight) on `day` that gives `needMin` working minutes' notice from now. */
function earliestWithNotice(day, now, needMin, sb = here()) {
  if (!isOpen(day, sb)) return Infinity;
  const need = day === 0 ? now + needMin : needMin - workMinutesUntil(day, 0, now, sb);
  return need <= 0 ? -Infinity : need;
}

/** The time to lodge a PCSE notice by: `needMin` working minutes before the visit. */
function lodgeBy(day, start, needMin, sb = here()) {
  let left = needMin, d = day, t = start;
  while (left > 0) {
    if (d < -400) break;
    if (isOpen(d, sb)) { const take = Math.min(left, t); left -= take; t -= take; }
    if (left > 0) { d -= 1; t = 1440; }
  }
  return { day: d, min: t };
}

/** Calendar for the browser: the open/closed state and labels of each day the office can see or book. */
function view(sb = here()) {
  const max = ahead("bookAheadDays", sb);
  const days = [];
  for (let d = -14; d <= max; d++) { const why = closedWhy(d, sb); days.push({ day: d, iso: iso(d, sb), label: label(d, sb), long: longLabel(d, sb), wd: weekday(d, sb), open: !why, why: why || undefined }); }
  return { today: todayISO(sb), live: !!(sb && sb.live), bookAheadDays: max, onlineAheadDays: ahead("onlineAheadDays", sb), offerAheadDays: ahead("offerAheadDays", sb), days };
}

/** Midnight today (UTC ms of the date), for working out ages. */
const todayMs = (sb = here()) => utc(todayISO(sb));
/** Monday to Friday of the current week, as day numbers (some may be in the past). */
const thisWeek = (sb = here()) => { const w = weekday(0, sb); return [0, 1, 2, 3, 4].map((i) => (w <= 4 ? i - w : i + 7 - w)); }; // at a weekend: the week ahead

/** The UK day number of today, for a live practice's midnight roll. */
const dayNumber = (isoDate) => Math.round(utc(isoDate) / DAY_MS);

module.exports = {
  DEMO_TODAY, WEEKDAYS, BANK_HOLIDAYS, todayISO, londonToday, dateOf, iso, weekday, dayOf, closedWhy, isOpen, label, longLabel, phrase,
  ahead, openDays, workMinutesUntil, earliestWithNotice, lodgeBy, view, dayNumber, todayMs, thisWeek,
};
