/* Domi — browser app. Talks to the API in server/, renders office and clinician views,
   and listens for live events. Re-renders keep what the person is typing, their focus and scroll. */
(function () {
"use strict";

/* ============ API ============ */
// The session lives in an HttpOnly cookie the page can't read. The only thing remembered here is which
// demo (practice) this browser was using, which isn't a secret.
let META = null, S = null, ES = null, fetchedAt = 0;
/* ---------- Practice branding ---------- */
// A branded demo is opened with /?brand=<id>; the choice is remembered on this device, and once a demo exists
// its own brand (from /api/state) is the one that counts.
const prefs = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} } };
let BRAND_ID = null;
DomiAreas.bind(() => (S && S.areas) || (META && META.areas));
function applyBrand(b) {
  if (!b) return;
  BRAND_ID = b.id;
  if (b.theme) document.documentElement.dataset.brand = b.id; else delete document.documentElement.dataset.brand;
  const lock = document.querySelector(".lockup");
  const key = [b.id, b.logo, b.practice].join("|");
  if (lock && lock.dataset.key !== key) {
    lock.dataset.brand = b.id; lock.dataset.key = key;
    lock.setAttribute("aria-label", b.practice);
    lock.innerHTML = b.logo
      ? `<img class="brand-logo" src="${esc(b.logo)}" alt="${esc(b.logoAlt)}" referrerpolicy="no-referrer"><span class="by">Powered by Domi</span>`
      : b.theme ? `<span class="wm keep"><b>${esc(b.practice)}</b><span>${esc(String(b.tagline || "").toUpperCase())}</span></span>`
      : `<img src="/logo.svg" alt=""><span class="wm"><b>Domi</b><span>EYE CARE AT HOME</span></span>`;
    // If their site can't be reached, show their name rather than a broken image.
    const img = lock.querySelector(".brand-logo");
    if (img) img.addEventListener("error", () => { lock.innerHTML = `<span class="wm keep"><b>${esc(b.practice || b.wordmark)}</b><span>${esc(b.tagline.toUpperCase())}</span></span>`; }, { once: true });
  }
  document.title = b.logo ? `${b.practice} · Diary` : "Domi";
  window.DomiPowered(b);
}
const UI = { tab: "today", pid: null, rec: null, q: "", drawer: null, flow: null, lastClin: "u-c1", busy: false, day: 0, view: "day", auth: { step: "password" }, pair: null, tray: "wait", route: { page: "today" }, pg: null, pq: "", pf: "all" };
let DEMO_SB = null;
try { DEMO_SB = localStorage.getItem("domi-demo"); localStorage.removeItem("domi-token"); } catch (e) {}
const rememberDemo = (c) => { DEMO_SB = c; try { c ? localStorage.setItem("domi-demo", c) : localStorage.removeItem("domi-demo"); } catch (e) {} };

async function api(method, url, body) {
  // X-Domi: a header a form on another site can't add, so the server can refuse forged requests.
  let res;
  try { res = await fetch(url, { method, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Domi": "1" }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { const err = new Error("No connection. This will work again when you have signal."); err.offline = true; throw err; }
  const data = await res.json().catch(() => ({ error: "The server sent something unexpected." }));
  if (res.status === 401 && !url.startsWith("/api/auth/")) { signedOut(); throw new Error(data.error); }
  if (!res.ok) throw Object.assign(new Error(data.error || "That didn't work. Try again."), { data, status: res.status });
  return data;
}
const fail = (e) => toast(e.message, true);
function signedOut(msg) {
  if (ES) { ES.close(); ES = null; }
  wipeOffline();
  const was = !!S;
  S = null; UI.pid = null; UI.rec = null; UI.pair = null; UI.auth = { step: "password" };
  closeDrawer(); render();
  if (msg && was) toast(msg, true);
}

/* ============ Helpers ============ */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(Math.floor(m) % 60).padStart(2, "0");
const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
const icon = (n, cls) => `<svg class="i ${cls || ""}"><use href="#i-${n}"/></svg>`;
const first = (n) => String(n).split(" ")[0];
const initials = (n) => String(n).split(" ").map((w) => w[0]).join("").slice(0, 2);
const district = (pc) => String(pc).split(" ")[0];
const active = (a) => a.status !== "cancelled";
/** A visit type, with this practice's own length (from /api/state; /api/meta has the defaults). */
const TYPES_NOW = () => (S && S.types) || META.types;
const T = (k) => TYPES_NOW()[k];
const isAdmin = () => !!S && S.user.role === "admin";
const pat = (id) => S.patients.find((p) => p.id === id) || { id, name: "Patient", pc: "", addr: "", alerts: [], phone: "" };
const cln = (id) => S.clinicians.find((c) => c.id === id);
/** A clinic's strength: its visits' true counts added up (recall 1, others 0.5, or what the office set). */
const countOf = (a) => (a.count != null ? a.count : 0.5);
const fmtCount = (n) => (Math.round(n * 100) / 100).toString();
const clinicCount = (cid, day) => S.appts.filter((a) => a.clinicianId === cid && (a.day || 0) === day && !["cancelled", "missed"].includes(a.status)).reduce((t, a) => t + countOf(a), 0);
const targetOf = () => (S.settings && S.settings.clinicTarget) || 10;
const strengthTag = (cid, day) => { const n = clinicCount(cid, day), t = targetOf(); return `<span class="tcount-line ${n < t * 0.7 ? "weak" : ""}" title="True count: how many patients are likely to be in, against your target of ${t}">True count <b>${fmtCount(n)}</b>/${t}</span>`; };
const dayAppts = (c, day = 0) => S.appts.filter((a) => a.clinicianId === c && (a.day || 0) === day && active(a)).sort((x, y) => x.start - y.start);
/* ---------- The calendar (server/calendar.js): day numbers count from today; weekends and holidays are closed ---------- */
let calOf = null, calMap = new Map();
const calDay = (d) => { if (!S || !S.cal) return null; if (calOf !== S.cal) { calOf = S.cal; calMap = new Map(S.cal.days.map((x) => [x.day, x])); } return calMap.get(d) || null; };
const dayName = (d) => (calDay(d) || {}).label || "";
const dayLong = (d) => (calDay(d) || {}).long || "";
const weekdayOf = (d) => { const x = calDay(d); return x ? x.wd : ((d % 7) + 7) % 7; };
const weekStart = (d) => d - weekdayOf(d);
/** Monday to Friday, for clinicians' working hours. */
const WD = () => META.weekdays || ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
/** A clinician's hours on a day: set per weekday; null on their day off, a weekend or a day the practice is shut. */
const hoursFor = (c, d) => { const x = calDay(d); if (x && !x.open) return null; const w = weekdayOf(d); if (w > 4) return null; const h = (c.hours || [])[w]; return h === undefined ? [dayS(), dayE()] : h; };
const dayByIso = (iso) => { const x = S && S.cal ? S.cal.days.find((y) => y.iso === iso) : null; return x ? x.day : null; };
const whenLabel = (day, start) => (day === 0 ? "" : dayName(day) + " · ") + hm(start);
const demoNow = () => S ? S.now + (Date.now() - fetchedAt) / 60000 : 620;
const money = (n) => "£" + Number(n || 0).toLocaleString("en-GB");

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.innerHTML = icon(bad ? "x" : "check") + esc(msg);
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
const clearErrors = () => document.querySelectorAll("#toasts .toast.bad").forEach((t) => t.remove());

/* Keep typing, focus and scroll across re-renders (live updates arrive while people work). */
function snapshot(root) {
  const a = document.activeElement;
  return {
    id: a && root.contains(a) ? a.id : null, ss: a && a.selectionStart, se: a && a.selectionEnd,
    vals: [...root.querySelectorAll("[data-keep]")].map((e) => [e.id, e.type === "checkbox" ? e.checked : e.value]),
    scroll: [...root.querySelectorAll("[data-scroll]")].map((e) => [e.dataset.scroll, e.scrollTop, e.scrollLeft]),
    y: window.scrollY,
  };
}
function restore(root, s) {
  s.vals.forEach(([id, v]) => { const e = document.getElementById(id); if (e && root.contains(e)) { if (e.type === "checkbox") e.checked = v; else e.value = v; } });
  s.scroll.forEach(([k, t, l]) => { const e = root.querySelector(`[data-scroll="${k}"]`); if (e) { e.scrollTop = t; e.scrollLeft = l; } });
  if (s.id) { const e = document.getElementById(s.id); if (e) { e.focus({ preventScroll: true }); try { if (s.ss != null) e.setSelectionRange(s.ss, s.se); } catch (err) {} } }
  window.scrollTo(0, s.y);
}
function paint(root, html) { const s = snapshot(root); root.innerHTML = html; restore(root, s); }

/* ============ Offline (clinician phone) ============ */
// Today's round and its patients' records are kept on the phone, so a visit can go ahead without signal.
// Changes made offline are queued and sent, in order, when the connection is back. Signing out wipes it all.
// Not kept for the office or the office's preview: only on a clinician's own signed-in phone.
const OFFLINE_KEY = "domi-offline", OUTBOX_KEY = "domi-outbox";
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del: (k) => { try { localStorage.removeItem(k); } catch (e) {} },
};
let outbox = store.get(OUTBOX_KEY, []), flushing = false;
const keepsOffline = () => !!S && !isAdmin() && !isOffice();
function wipeOffline() { store.del(OFFLINE_KEY); store.del(OUTBOX_KEY); outbox = []; UI.offline = false; }
function saveOffline() {
  if (!keepsOffline()) return;
  const prev = store.get(OFFLINE_KEY, {});
  store.set(OFFLINE_KEY, { meta: META, state: S, fetchedAt, savedAt: Date.now(), records: prev.user === S.user.id ? prev.records || {} : {}, user: S.user.id });
}
/** Keep the records of everyone on today's round, so they open without signal. */
async function prefetchRecords() {
  if (!keepsOffline() || UI.offline) return;
  const ids = [...new Set(dayAppts(S.clinicians[0].id).map((a) => a.patientId))];
  const records = {};
  for (const id of ids) { try { records[id] = await api("GET", "/api/patients/" + id + "?background=1"); } catch (e) { if (e.offline) return; } }
  let route = null; try { route = await api("GET", "/api/route?day=0"); } catch (e) { /* the map just won't be offline */ }
  const c = store.get(OFFLINE_KEY, null); if (c) { c.records = records; c.route = route; store.set(OFFLINE_KEY, c); }
}
function goOffline() {
  const c = store.get(OFFLINE_KEY, null);
  if (!c || (S && c.user !== S.user.id)) return false;
  if (!S) { S = c.state; META = META || c.meta; fetchedAt = c.fetchedAt; }
  if (!UI.offline) { UI.offline = true; toast("No signal. Your round is saved on this phone, and changes will sync later."); }
  render();
  return true;
}
/** A change made without signal: shown straight away, sent when the connection is back. */
function queueChange(url, body, apply) {
  outbox.push({ url, body, at: Date.now() }); store.set(OUTBOX_KEY, outbox);
  apply();
  const c = store.get(OFFLINE_KEY, null);
  if (c) { c.state = S; if (UI.rec) c.records[UI.rec.id] = UI.rec; store.set(OFFLINE_KEY, c); }
  render();
}
async function flush() {
  if (flushing) return; flushing = true;
  let sent = 0;
  try {
    while (outbox.length) {
      const job = outbox[0];
      try { await api("POST", job.url, job.body); sent++; }
      catch (e) { if (e.offline) return; toast(`One change couldn't sync: ${e.message}`, true); }
      outbox.shift(); store.set(OUTBOX_KEY, outbox);
    }
  } finally { flushing = false; }
  UI.offline = false;
  if (sent) toast(`Back online. ${sent} change${sent === 1 ? "" : "s"} synced.`);
  await load(); connect();
}
window.addEventListener("offline", () => { if (keepsOffline()) goOffline(); });
window.addEventListener("online", () => { if (S && (UI.offline || outbox.length)) flush().catch(() => {}); });

/* ============ Data + live updates ============ */
async function load() {
  if (outbox.length && !flushing) { if (S && navigator.onLine !== false) return flush(); }
  try { S = await api("GET", "/api/state"); }
  catch (e) { if (e.offline && goOffline()) return; throw e; }
  applyBrand(S.brand);
  fetchedAt = Date.now(); UI.offline = false;
  saveOffline(); prefetchRecords();
  if (S.user.clinicianId) UI.lastClin = "u-" + S.user.clinicianId;
  const inv = panel("invoices"); if (inv) inv.data = await api("GET", "/api/invoices").catch(() => inv.data);
  if (UI.myRoute && !isAdmin()) UI.myRoute = await api("GET", "/api/route?day=0").catch(() => null);
  if (UI.pid) { try { UI.rec = await api("GET", "/api/patients/" + UI.pid + "?background=1"); } catch (e) { UI.pid = null; UI.rec = null; } }
  const d = UI.drawer;
  if (d && d.kind === "patient" && !d.edit) d.rec = await api("GET", "/api/patients/" + d.id + "?background=1").catch(() => d.rec);
  if (d && d.kind === "team" && !d.edit) d.data = await api("GET", "/api/team").catch(() => d.data);
  UI.route = parseRoute(); await syncPage();
  if (!pageEditing()) render();
  // A form being filled in isn't redrawn by live updates, so nothing typed or picked is lost.
  if (UI.drawer && !UI.drawer.edit) redraw();
}
let refetchT = null;
const refetch = () => { clearTimeout(refetchT); refetchT = setTimeout(() => load().catch(() => {}), 120); };

const EVENTS = ["patient.updated", "appointment.moved", "team.updated", "refill.started", "reminders.sent", "recall.updated", "invoice.updated", "appointment.booked", "appointment.updated", "offer.sent", "offer.declined", "offer.expired", "slot.filled", "slot.unfilled", "sms.received", "note.added", "waitlist.added", "settings.updated", "pcse.updated", "patients.imported", "route.planned", "referral.updated", "lead.updated", "reset"];
function connect() {
  if (ES) ES.close();
  ES = new EventSource("/api/events"); // same-origin, so the session cookie goes with it
  const live = (on) => $("#clock").classList.toggle("off", !on);
  ES.addEventListener("hello", () => live(true));
  ES.addEventListener("signedout", (ev) => { const e = JSON.parse(ev.data); signedOut(/office/.test(e.why) ? "The office signed this device out." : "You've been signed out."); });
  ES.onerror = () => live(false);
  EVENTS.forEach((type) => ES.addEventListener(type, (ev) => {
    const e = JSON.parse(ev.data);
    onEvent(type, e);
    refetch();
  }));
}
function onEvent(type, e) {
  if (type === "reset") { UI.pid = null; UI.rec = null; closeDrawer(); toast("This demo was started again"); return; }
  if (!isAdmin()) {
    if (type === "slot.filled") toast(`Diary changed: ${e.patient} at ${hm(e.start)}`);
    if (type === "route.planned") toast(`Your route ${e.day === 0 ? "today" : "on " + dayName(e.day)} has been re-planned: ${mins(e.savedMin)} less driving`);
    if (type === "appointment.booked") toast(`New visit${e.online ? " (booked online)" : ""}: ${e.patient}, ${e.day ? dayName(e.day) + " " : ""}${hm(e.start)}`);
    if (type === "appointment.moved") toast("The office has moved a visit on your round");
    return;
  }
  if (type === "referral.updated" && e.fresh) toast("New referral from the website form");
  if (type === "lead.updated" && e.fresh) toast("New lead from your Facebook ad: thank-you email sent");
  if (type === "appointment.booked" && e.online) toast(`Booked online by the patient: ${e.patient}, ${dayName(e.day)} ${hm(e.start)} (+${e.extraDrive} min driving)`);
  if (type === "refill.started") {
    if (e.cancelled && e.cancelled.byText) toast(`${e.cancelled.patient} texted to cancel. Refilling ${hm(e.start)}.`);
    if (e.cancelled && e.cancelled.byLink) toast(`${e.cancelled.patient}'s visit was cancelled online. Refilling ${hm(e.start)}.`);
    if (e.outcome === "call-list") { openCallList(e.slotId); return; }
    if (!UI.flow || UI.flow.slotId !== e.slotId) { UI.flow = flowFrom(e); openDrawer({ kind: "flow" }); }
    return;
  }
  const f = UI.flow;
  if (!f || e.slotId !== f.slotId) return;
  const offer = (id) => f.rounds.flatMap((r) => r.offers).find((o) => o.offerId === id);
  if (type === "offer.declined") { const o = offer(e.offerId); if (o) o.status = "declined"; }
  else if (type === "offer.expired") { const o = offer(e.offerId); if (o) o.status = "expired"; }
  else if (type === "offer.sent") f.rounds.push(roundFrom(e));
  else if (type === "slot.filled") {
    f.outcome = "booked"; f.booking = e;
    f.rounds.forEach((r) => r.offers.forEach((o) => { if (o.status === "pending") o.status = o.name === e.patient ? "accepted" : "taken"; }));
    toast(`${e.patient} moved forward to ${hm(e.start)}`);
  } else if (type === "slot.unfilled") { f.outcome = "unfilled"; f.why = e.why; }
  else return;
  if (UI.drawer && UI.drawer.kind === "flow") redraw();
}

/* ---------- Sign-in: password, then the code from an authenticator app ---------- */
async function enter() {
  clearErrors();
  UI.tab = "today"; UI.pid = null; UI.rec = null; UI.myRoute = null; UI.auth = { step: "password" };
  await load();
  connect();
}
async function submitPassword(email, password, join) {
  if (META.live) { // a real practice: no demo to start
    const code = META.live.practice ? META.live.practice.code : String(join || "").toUpperCase();
    const r = await api("POST", "/api/auth/password", { sandbox: code, email, password });
    UI.auth = { step: "code", challenge: r.challenge, name: r.name, email };
    clearErrors(); render();
    const c = $("#code"); if (c) c.focus();
    return;
  }
  const start = (body) => api("POST", "/api/demo/start", body).then((r) => r.sandbox);
  let sb = join ? await start({ join: join.toUpperCase() }) : DEMO_SB || await start({ brand: BRAND_ID });
  let r;
  try { r = await api("POST", "/api/auth/password", { sandbox: sb, email, password }); }
  catch (e) {
    if (join || !/expired/.test(e.message)) throw e;
    sb = await start(); // the demo this browser remembered has been cleared: start a fresh one
    r = await api("POST", "/api/auth/password", { sandbox: sb, email, password });
  }
  rememberDemo(sb);
  UI.auth = { step: "code", challenge: r.challenge, name: r.name, email, enrol: r.demo && r.demo.enrol };
  clearErrors(); render();
  const c = $("#code"); if (c) c.focus();
}
async function submitCode(code) {
  try {
    const r = await api("POST", "/api/auth/code", { challenge: UI.auth.challenge, code });
    rememberDemo(r.sandbox);
    await enter();
  } catch (e) {
    if (/password again/.test(e.message)) { UI.auth = { step: "password", email: UI.auth.email }; render(); }
    throw e;
  }
}
/** The office looking at the app as a clinician sees it (or back to the office). */
async function viewAs(userId, asOffice = false) {
  // A director (a clinician with office access) is the same account in both views: say which one.
  await api("POST", "/api/auth/view-as", { userId, as: asOffice ? "office" : "clinician" });
  await enter();
}
const isOffice = () => !!S && !!S.signedInAs && S.signedInAs.role === "admin";

/* ============ Render ============ */
function render() {
  const signedIn = !!S;
  { const f = $("#clock .full"); if (f && S && S.cal) f.textContent = dayName(0); }
  $("#clock").hidden = !signedIn; $("#roles").hidden = !signedIn || !isOffice(); $("#actions").hidden = !signedIn;
  $("#reset").hidden = !isOffice() || !!META.live; // a live practice can't be reset
  if (META.live) $("#open-phone").hidden = true;    // phone pairing by QR is a demo shortcut
  document.body.classList.toggle("clin-mode", signedIn && !isAdmin());
  if (!signedIn) { $("#app").innerHTML = signInView(); return; }
  $("#role-admin").setAttribute("aria-pressed", isAdmin());
  $("#role-clin").setAttribute("aria-pressed", !isAdmin());
  $("#open-phone").hidden = !isAdmin() || !!META.live;
  paint($("#app"), isAdmin() ? officeShell() : clinView());
  mountMaps($("#app"));
  tick();
}

function signInView() {
  const users = META ? META.demoUsers : [];
  const A = UI.auth;
  const brand = `<section class="signin-brand">
      <div>
        <div class="caps" style="color:inherit;opacity:.7">${META.brand && META.brand.logo ? esc(META.brand.practice) : "Domiciliary eye care"}</div>
        ${META.brand && META.brand.logo ? `<h1 style="margin-top:14px">Every home visit, <em>in one place.</em></h1>
        <p>Patients, referrals, diaries and each clinician's route, all here: no spreadsheets, no documents. When someone cancels, the next patient who can be seen is offered the slot by text.</p>`
        : `<h1 style="margin-top:14px">Eye care that <em>comes to you.</em></h1>
        <p>A diary for home-visit opticians. When someone cancels, the next patient who can be seen is offered the slot by text, and the clinician's phone updates on its own.</p>`}
      </div>
      <ul class="features">
        <li><span class="ic">${icon("bolt")}</span><span><b>Cancellations refill themselves</b><em>Ranked by urgency, area, wait and travel time.</em></span></li>
        <li><span class="ic">${icon("phone")}</span><span><b>Built for the round</b><em>Visits, records and notes on the clinician's phone.</em></span></li>
        <li><span class="ic">${icon("shield")}</span><span><b>Two-step sign-in, every change audited</b><em>Password and authenticator code. Who did what, and who opened which record.</em></span></li>
      </ul>
    </section>`;
  if (A.step === "code") {
    let qr = "";
    if (A.enrol) { try { const q = qrcode(0, "M"); q.addData(A.enrol); q.make(); qr = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true }); } catch (e) { qr = ""; } }
    return `<div class="signin">${brand}
    <form class="signin-form" id="code-form" autocomplete="off">
      <div><div class="caps">Step 2 of 2 · ${esc(A.name)}</div><h2 style="margin-top:8px">Enter your code</h2>
      <p class="muted" style="margin:8px 0 0">Open the authenticator app on your phone and type the 6-digit code it shows for Domi. Codes change every 30 seconds.</p></div>
      <div class="field"><label for="code">6-digit code</label><input class="input otp" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000" data-keep></div>
      <button class="btn block lg" type="submit">${icon("shield")}Verify and sign in</button>
      ${META.demo ? `<div class="demo-help"><div><b>Demo shortcut</b><span>Nobody has the app set up for this sample practice, so the demo can read the code for you.</span></div>
        <button class="btn secondary sm" type="button" data-act="demo-code">${icon("bolt")}Fill in the current code</button>
        ${qr ? `<details><summary>Or try it with a real authenticator app</summary><div class="enrol"><div class="qr sm">${qr}</div><p class="muted">Scan with Google Authenticator, Microsoft Authenticator or 1Password. The app then shows the same codes. In the real system this is a one-time setup after a person's first sign-in.</p></div></details>` : ""}</div>` : ""}
      <button class="linkish" type="button" data-act="auth-back">${icon("back")}Use a different account</button>
    </form></div>`;
  }
  if (META.live) {
    const P = META.live.practice;
    return `<div class="signin">${brand}
    <section class="signin-form">
      <div><div class="caps">${P ? esc(P.name) : "Domi"}</div><h2 style="margin-top:8px">Sign in</h2>
      <p class="muted" style="margin:8px 0 0">Your email and password, then the code from your authenticator app.</p></div>
      <form id="pw-form" class="pw-form">
        ${P ? "" : `<div class="field"><label for="join-code">Practice code</label><input class="input code-input" id="join-code" maxlength="12" autocomplete="organization" required data-keep value="${esc(A.join || "")}"></div>`}
        <div class="field"><label for="email">Email</label><input class="input" id="email" type="email" autocomplete="username" required data-keep value="${esc(A.email || "")}"></div>
        <div class="field"><label for="password">Password</label><input class="input" id="password" type="password" autocomplete="current-password" required data-keep></div>
        <button class="btn block lg" type="submit">Continue${icon("next")}</button>
        <p class="hint">${icon("shield")}<span>Forgotten your password, or got a new phone? Ask your practice office to reset your sign-in. You'll get a link to set it up again in two minutes.</span></p>
      </form>
    </section>
  </div>`;
  }
  return `<div class="signin">${brand}
    <section class="signin-form">
      <div><div class="caps">Private demo</div><h2 style="margin-top:8px">Sign in</h2>
      <p class="muted" style="margin:8px 0 0">Each demo is a private copy of a sample practice: nobody else sees your changes. Pick a sample account to fill in its details.</p></div>
      <div class="users">${users.map((u, i) => `<button class="user-opt ${i === 0 ? "primary" : ""}" type="button" data-act="pick-user" data-email="${esc(u.email)}">
        <span class="avatar" style="background:${u.color}">${initials(u.name)}</span>
        <span><b>${esc(u.name)}</b><div class="r">${u.role === "admin" ? "Office manager · sees every diary" : esc(u.title) + " · own round only"}</div></span>${icon("next")}</button>`).join("")}</div>
      <form id="pw-form" class="pw-form">
        <div class="field"><label for="email">Email</label><input class="input" id="email" type="email" autocomplete="username" required data-keep value="${esc(A.email || "")}"></div>
        <div class="field"><label for="password">Password</label><input class="input" id="password" type="password" autocomplete="current-password" required data-keep></div>
        ${META.demo ? `<p class="hint">${icon("shield")}<span>Demo password for every sample account: <span class="mono">${esc(META.demo.password)}</span></span></p>` : ""}
        <details ${A.join ? "open" : ""}><summary>Joining a demo that's open on another screen?</summary>
          <div class="field" style="margin-top:10px"><label for="join-code">Demo code</label><input class="input code-input" id="join-code" maxlength="6" placeholder="ABC123" autocomplete="off" data-keep value="${esc(A.join || "")}"></div></details>
        <button class="btn block lg" type="submit">Continue${icon("next")}</button>
        <button class="linkish" type="button" data-act="soon" data-id="reset" style="align-self:center">Forgot your password?<span class="soon-pill">Soon</span></button>
      </form>
    </section>
  </div>`;
}

/* ---------- Office ---------- */
function officeView() {
  const all = S.appts.filter((a) => active(a) && (a.day || 0) === 0), waiting = S.waitlist.filter((w) => w.status !== "booked"), m = S.metrics, st = S.settings;
  const nowM = demoNow();
  const left = all.filter((a) => a.status !== "done").length;
  return `<div class="shell">
    <div class="page-head">
      <div><div class="caps">${esc(dayLong(0))}</div><h1 style="margin-top:6px">Today across the team</h1>
        <p>${(() => { const n = onBoard(0).filter((c) => hoursFor(c, 0) !== null).length; return n === 1 ? "One clinician" : (["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"][n] || n) + " clinicians"; })()} on the road. Cancel any visit and the best-matched patient from the waiting list is offered the slot straight away.</p>
        </div>
      <div class="quick-stats">
        <button class="btn lg" type="button" data-act="book" style="align-self:center">${icon("plus")}Book a visit</button>
        <div class="qs"><b>${all.length}</b><span>home visits</span></div>
        <div class="qs"><b>${left}</b><span>still to go</span></div>
        <div class="qs"><b>${waiting.length}</b><span>waiting list</span></div>
      </div>
    </div>
    <section class="income" aria-label="Income recovered">
      <div><div class="big">${money(m.recovered)}</div><div class="lab">recovered this week from cancelled visits</div></div>
      <div class="kpi"><b>${m.refilled}<span style="font-size:18px;opacity:.7"> / ${m.cancellations}</span></b><div class="lab">cancellations refilled</div></div>
      <div class="kpi"><b>${m.avgRefillMin == null ? "–" : m.avgRefillMin < 1 ? "<1 min" : m.avgRefillMin + " min"}</b><div class="lab">average time to refill</div></div>
      <div class="kpi"><b>${money(m.atRisk)}</b><div class="lab">still unfilled</div></div>
      <div class="fee"><span>Your fee per visit</span><label>£<input id="fee" data-keep type="number" min="0" max="2000" step="5" value="${m.fee}" aria-label="Fee per visit in pounds"></label><span style="opacity:.7">Example figure. Set your own.</span></div>
    </section>
    ${needsYou()}
    <div class="grid">
      <section class="panel" aria-label="Diaries">
        <div class="panel-h"><h2>Diaries</h2>
          ${dayNav()}
        </div>
        ${UI.view === "week" ? weekView() : `<div class="panel-h" style="padding-top:0"><span class="sub">${UI.day === 0 ? "Today, " + esc(dayLong(0)) : esc(dayLong(UI.day))}${calDay(UI.day) && !calDay(UI.day).open ? ` · <b>Closed: ${esc(calDay(UI.day).why)}</b>` : ""}</span>
          <div class="legend"><span><i class="sw" style="background:var(--surface)"></i>Booked</span><span><i class="sw" style="background:var(--warn-soft)"></i>On the way</span><span><i class="sw" style="background:var(--ok-soft)"></i>With patient</span><span><i class="sw" style="background:var(--subtle)"></i>Done</span><span><i class="sw" style="background:var(--apricot-soft)"></i>Moved forward</span><span><i class="sw" style="background:var(--forest-soft)"></i>New booking</span></div>
        </div>
        <div class="board-wrap" data-scroll="board">${board(nowM)}</div>`}
      </section>
      ${tray()}
    </div></div>`;
}
/* ---------- The work tray: everything beside the diary, one tab at a time ---------- */
function waitingPanel() {
  const st = S.settings;
  return `<section class="panel" aria-label="Waiting list">
          <div class="panel-h"><h2>Waiting list</h2><button class="btn sm" data-act="add-wl" type="button">${icon("plus")}Add</button></div>
          <div class="mode"><div class="caps">When a visit is cancelled</div>
            <div class="seg" role="group" aria-label="Refill mode">
              <button type="button" data-act="mode" data-v="offer" aria-pressed="${st.mode === "offer"}">${icon("msg")}Text an offer</button>
              <button type="button" data-act="mode" data-v="instant" aria-pressed="${st.mode === "instant"}">${icon("bolt")}Book instantly</button>
            </div>
            <p>${st.mode === "offer"
              ? `Patients reply YES to take it. Normal reply window <select id="offer-min" aria-label="Reply window">${[5, 10, 20, 30, 60].map((n) => `<option value="${n}" ${n === st.offerMinutes ? "selected" : ""}>${n} min</option>`).join("")}</select>, shorter when the visit is close. Under an hour away, the top three are asked at once.`
              : "The slot is booked straight away and the patient is told by text. They can reply NO to keep their place."}</p>
            <label class="practice-name">Texts are signed <input id="practice-name" data-keep maxlength="60" value="${esc(st.practice)}" aria-label="Practice name, as patients see it"></label>
          </div>
          <div class="hr"></div>
          <ul class="wl">${S.waitlist.map(wlItem).join("")}</ul>
        </section>`;
}
function textsPanel() {
  return `${remindersPanel()}
        <section class="panel" aria-label="Texts">
          <div class="panel-h"><h2>Texts</h2><span class="sub">${S.messages.length} today · ${META.smsProvider === "twilio" ? "sending live" : "demo outbox"}</span></div>
          ${S.messages.length ? `<div class="feed" data-scroll="feed">${S.messages.map(smsBubble).join("")}</div>`
            : `<div class="empty"><b>No texts yet</b>Click a booked visit in a diary to cancel it, or to play the patient texting CANCEL.</div>`}
        </section>`;
}
/** Each tab: what it holds, how many need the office, and whether that number is urgent. */
function trayTabs() {
  const n = (a) => a.length;
  const leads = (S.leads || []).filter((l) => l.status === "new");
  const oldest = leads.reduce((m, l) => Math.max(m, (S.now || 0) - l.atMin), 0);
  return [
    { k: "wait", label: "Waiting", ic: "users", count: n(S.waitlist.filter((w) => w.status !== "booked")), body: waitingPanel },
    { k: "leads", label: "Leads", ic: "send", count: n(leads), hot: oldest > 60, body: leadsPanel },
    { k: "refs", label: "Referrals", ic: "note", count: n((S.referrals || []).filter((r) => r.status === "new")), hot: (S.referrals || []).some((r) => r.status === "new" && r.urgent), body: referralsPanel },
    { k: "recalls", label: "Recalls", ic: "cal", count: n((S.recalls || []).filter((r) => r.status !== "dismissed" && r.status !== "booked")), body: recallsPanel },
    { k: "notseen", label: "Not seen", ic: "x", count: n(notSeenToday().filter((x) => !x.back)), hot: notSeenToday().some((x) => !x.back), body: notSeenPanel },
    { k: "pcse", label: "PCSE", ic: "shield", count: n((S.pcse || []).filter((t) => t.status === "todo")), body: pcsePanel },
    { k: "texts", label: "Texts", ic: "msg", count: n(S.messages.filter((m) => m.dir === "in" && !m.read)), body: textsPanel },
  ];
}
function tray() {
  const tabs = trayTabs(), cur = tabs.find((t) => t.k === UI.tray) || tabs[0];
  const body = cur.body() || `<div class="empty"><b>Nothing here yet</b>${cur.k === "pcse" ? "Booking an NHS sight test adds the notification to lodge." : "New items appear here as they arrive."}</div>`;
  return `<aside class="tray" aria-label="Work tray">
    <nav class="tray-rail" role="tablist" aria-label="Work tray sections">${tabs.map((t) => `<button type="button" role="tab" data-act="tray" data-v="${t.k}" aria-selected="${t === cur}" aria-controls="tray-body">${icon(t.ic)}<span class="tl">${t.label}</span>${t.count ? `<span class="tc ${t.hot ? "hot" : ""}">${t.count}</span>` : ""}</button>`).join("")}</nav>
    <div class="tray-body" id="tray-body" role="tabpanel" data-scroll="tray-${cur.k}">${body}</div>
  </aside>`;
}
/** What needs a person today, above the diary. Each card opens its tab in the tray. */
/** Today's visits a clinician couldn't do, and whether each patient is back on the waiting list. */
function notSeenToday() {
  return S.appts.filter((a) => (a.day || 0) === 0 && a.status === "missed").map((a) => ({ a, p: pat(a.patientId), back: S.waitlist.some((w) => w.patientId === a.patientId && w.status !== "booked") })).filter((x) => x.p);
}
function notSeenPanel() {
  const list = notSeenToday();
  return `<section class="panel" aria-label="Not seen today">
    <div class="panel-h"><h2>Not seen today</h2><span class="sub">${list.length ? `${list.filter((x) => !x.back).length} to rebook` : "None"}</span></div>
    <p class="panel-note">Visits a clinician couldn't do, marked from their phone. Anyone not back on the waiting list needs a call to rebook.</p>
    ${list.length ? `<ul class="recalls">${list.map(({ a, p, back }) => `<li>
      <div style="min-width:0"><div class="nm">${esc(p.name)}</div><div class="meta"><span>${hm(a.start)} with ${esc((cln(a.clinicianId) || {}).first || "")}</span><span>${esc(a.reason || "Not seen")}</span><span>${p.contact === "Call" ? "Phone, don't text" : esc(p.phone)}</span></div></div>
      <div class="ra">${back ? `<span class="badge b-ok">On the waiting list</span>` : `<button class="btn secondary sm" type="button" data-act="go" data-v="patients/${esc(p.id)}">${icon("phone")}Call to rebook</button>`}</div></li>`).join("")}</ul>`
      : `<div class="empty"><b>Every visit went ahead</b>If a clinician can't do one, it appears here straight away.</div>`}
  </section>`;
}
function needsYou() {
  const leads = (S.leads || []).filter((l) => l.status === "new");
  const oldest = leads.reduce((m, l) => Math.max(m, (S.now || 0) - l.atMin), 0);
  const refs = (S.referrals || []).filter((r) => r.status === "new");
  const pcse = (S.pcse || []).filter((t) => t.status === "todo");
  const recalls = (S.recalls || []).filter((r) => r.status !== "dismissed" && r.status !== "booked");
  const overdue = recalls.filter((r) => r.dueDay < 0).length;
  const tomorrow = S.appts.filter((a) => (a.day || 0) === 1 && a.status === "booked"), unreminded = tomorrow.filter((a) => !a.reminded).length;
  const ago = (m) => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
  const cards = [
    { k: "leads", none: "No leads waiting", n: leads.length, what: leads.length === 1 ? "lead to call" : "leads to call", note: leads.length ? `Oldest waiting ${ago(oldest)}` : "Everyone's been called", hot: oldest > 60 },
    { k: "refs", none: "No new referrals", n: refs.length, what: refs.length === 1 ? "referral to look at" : "referrals to look at", note: refs.some((r) => r.urgent) ? "One says their sight has changed" : refs.length ? "From your website form" : "All dealt with", hot: refs.some((r) => r.urgent) },
    { k: "recalls", none: "No recalls due", n: recalls.length, what: recalls.length === 1 ? "recall due" : "recalls due", note: overdue ? `${overdue} overdue` : "Offered cancelled visits nearby", hot: false },
    (() => { const v = S.pvn || { breach: 0, todo: 0, cancels: 0 }, n = v.breach + v.todo + v.cancels; return { k: "pcse", go: "pvn", none: "PCSE is up to date", n, what: n === 1 ? "PCSE notice to do" : "PCSE notices to do", note: v.breach ? `${v.breach} inside the notice period` : n ? "Lodge before each deadline" : "Nothing to lodge", hot: v.breach > 0 }; })(),
    (() => { const ns = notSeenToday(), todo = ns.filter((x) => !x.back).length; return { k: "notseen", none: ns.length ? `${ns.length} not seen, all rebooked` : "Every visit went ahead", n: todo, what: todo === 1 ? "visit not seen: rebook" : "visits not seen: rebook", note: todo ? "Marked from the clinician's phone" : ns.length ? "Back on the waiting list" : "Nothing missed today", hot: todo > 0 }; })(),
    (() => { const c = S.calls || { 1: 0, 2: 0, 3: 0 }, n = c[1] + c[2] + c[3]; return { k: "calls", go: "calls", none: "Every call is made", n, what: n === 1 ? "confirmation call" : "confirmation calls", note: n ? [c[3] && `${c[3]} for tomorrow`, c[2] && `${c[2]} this week`, c[1] && `${c[1]} new`].filter(Boolean).join(" · ") : S.settings.reminders ? `${unreminded} reminder text${unreminded === 1 ? "" : "s"} at ${hm(S.settings.reminderAt)}` : "Reminder texts are off", hot: c[3] > 0 }; })(),
  ];
  void tomorrow;
  return `<section class="needs" aria-label="Needs you today"><div class="needs-h caps">Needs you today</div>
    <div class="needs-row">${cards.map((c) => `<button type="button" class="need ${c.n ? "" : "clear"} ${c.hot ? "hot" : ""}" ${c.go ? `data-act="go" data-v="${c.go}"` : `data-act="tray" data-v="${c.k}" data-jump="1" aria-pressed="${UI.tray === c.k}"`}>
      <span class="nn">${c.n ? c.n : icon("check")}</span><span class="nw"><b>${c.n ? c.what : c.none}</b><span>${esc(c.note)}</span></span></button>`).join("")}</div></section>`;
}
/** How long a new lead has been waiting for a call, on the demo clock. */
const leadWait = (l) => { const m = Math.max(0, (S.now || 0) - l.atMin); return m < 1 ? "just now" : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${Math.floor(m / 1440)} day${m >= 2880 ? "s" : ""}`; };
const LEAD_BADGE = { new: "b-apricot", contacted: "b-forest", booked: "b-ok", closed: "b-plain" };
/** Leads from the practice's Facebook ads: people asking to be called. Each is emailed a thank-you as it arrives. */
function leadsPanel() {
  const all = S.leads || [], fresh = all.filter((l) => l.status === "new"), open = all.filter((l) => l.status === "new" || l.status === "contacted");
  const done = all.length - open.length;
  return `<section class="panel" aria-label="Facebook leads">
    <div class="panel-h"><h2>Facebook leads</h2><span class="sub">${fresh.length ? `${fresh.length} to call` : "All called"}</span></div>
    <p class="panel-note">From the form on your Facebook ads. Each person was emailed a thank-you with your office hours the moment they sent it. Call them, then mark what happened.</p>
    <div style="padding:0 18px 8px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn secondary sm" type="button" data-act="adform">${icon("send")}Send a test lead</button><button class="btn ghost sm" type="button" data-act="lead-email">${icon("msg")}The thank-you email</button></div>
    ${open.length ? `<ul class="recalls">${open.map((l) => {
      const wait = l.status === "new" ? Math.max(0, (S.now || 0) - l.atMin) : 0;
      return `<li><div style="min-width:0"><div class="nm">${esc(l.name)} <span class="badge ${LEAD_BADGE[l.status]}">${esc(S.leadStatus[l.status])}</span>${l.patientId ? ` <span class="badge b-plain">Existing patient</span>` : ""}</div>
      <div class="meta"><span class="mono">${esc(l.phone || l.email || "")}</span>${l.pc ? `<span>${esc(l.pc)}</span>` : ""}${l.status === "new" ? `<span class="${wait > 60 ? "late" : ""}">Waiting ${leadWait(l)}</span>` : `<span>${esc(l.handledBy || "")} · ${esc(l.handledAt || "")}</span>`}</div></div>
      <div class="ra"><button class="btn ${l.status === "new" ? "" : "secondary "}sm" type="button" data-act="lead" data-id="${l.id}">Open</button></div></li>`; }).join("")}</ul>` : `<div class="empty"><b>No leads waiting</b>New ones from your ads appear here straight away.</div>`}
    ${done ? `<p class="panel-note" style="padding-bottom:14px">${done} dealt with (booked or not interested).</p>` : ""}
  </section>`;
}
function leadDrawer(d) {
  const l = (S.leads || []).find((x) => x.id === d.id);
  if (!l) return "";
  const mail = (S.leadEmails || []).find((m) => m.leadId === l.id);
  const p = l.patientId && S.patients.find((x) => x.id === l.patientId);
  const row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : "";
  return `<div class="drawer-h"><div><div class="caps">Facebook lead · ${esc(l.at)}${l.campaign ? ` · ${esc(l.campaign)}` : ""}</div><h2 style="margin-top:6px">${esc(l.name)}</h2></div>${closeX}</div>
    <div class="drawer-b">
      ${l.status === "new" ? `<div class="callout apricot" style="margin-bottom:14px">${icon("clock")}<div><b>Waiting ${leadWait(l)} for a call</b><div style="margin-top:2px">People who are called within the hour are far more likely to book.</div></div></div>` : ""}
      ${p ? `<div class="callout" style="margin-bottom:14px">${icon("users")}<div><b>Already a patient</b><div style="margin-top:2px">${esc(p.name)}, ${esc(p.pc)}. <button class="linkish" type="button" data-act="open-rec" data-id="${p.id}">Open their record</button></div></div></div>` : ""}
      <dl class="kv">${row("Phone", l.phone ? `<a class="mono" href="tel:${esc(l.phone.replace(/\s/g, ""))}">${esc(l.phone)}</a> <button class="btn ghost sm" type="button" data-act="copy" data-v="${esc(l.phone)}">${icon("copy")}Copy</button>` : "None given")}
        ${row("Email", esc(l.email || "None given"))}${row("Postcode", esc(l.pc || ""))}${l.answers.map(([q, a]) => row(esc(q), esc(a))).join("")}</dl>
      <div class="hr" style="margin:18px 0"></div>
      <div class="caps" style="margin-bottom:8px">Thank-you email ${mail ? `· sent at ${esc(mail.at)}` : ""}</div>
      ${mail ? `<div class="mailcard"><div class="mail-h"><b>${esc(mail.subject)}</b><span class="muted">To ${esc(mail.to)}</span></div><div class="mail-b">${esc(mail.body)}</div></div>`
        : `<p class="muted" style="margin:0">No email address was given, so no thank-you email went. Call them instead.</p>`}
      <div class="hr" style="margin:18px 0"></div>
      <div class="field"><label for="ld-note">Note from the call</label><textarea class="input" id="ld-note" rows="3" placeholder="e.g. Spoke to her daughter. Wants a morning visit next week.">${esc(l.note || "")}</textarea></div>
      ${l.handledBy ? `<p class="muted" style="font-size:13px;margin:6px 0 0">Last updated by ${esc(l.handledBy)} at ${esc(l.handledAt)}.</p>` : ""}
    </div>
    <div class="drawer-f" style="flex-wrap:wrap">${["contacted", "booked", "closed"].map((k) => `<button class="btn ${k === "booked" ? "" : k === "closed" ? "ghost" : "secondary"}" type="button" data-act="lead-status" data-id="${l.id}" data-v="${k}" aria-pressed="${l.status === k}">${k === "booked" ? icon("check") : k === "contacted" ? icon("phone") : ""}${k === "contacted" ? "Called" : esc(S.leadStatus[k])}</button>`).join("")}</div>`;
}
/** What every lead is emailed, and the office hours in it, which the office can change. */
function leadEmailDrawer() {
  const pv = S.leadPreview || { subject: "", body: "" };
  return `<div class="drawer-h"><div><div class="caps">Facebook leads</div><h2 style="margin-top:6px">The thank-you email</h2></div>${closeX}</div>
    <div class="drawer-b">
      <p class="muted" style="margin:0 0 14px">Sent automatically the moment someone fills in the form on your ad, if they give an email address. It comes from your practice, not from Domi.</p>
      <div class="field"><label for="ld-hours">Office hours, as they appear in the email</label><input class="input" id="ld-hours" maxlength="120" value="${esc(S.settings.officeHours || "")}"></div>
      <div style="margin:8px 0 18px"><button class="btn secondary sm" type="button" data-act="lead-hours">Save office hours</button></div>
      <div class="caps" style="margin-bottom:8px">What they receive</div>
      <div class="mailcard"><div class="mail-h"><b>${esc(pv.subject)}</b><span class="muted">From ${esc(S.settings.practice)}</span></div><div class="mail-b">${esc(pv.body)}</div></div>
    </div>`;
}
/** Referrals from the website form, waiting for the office to accept or decline. */
function referralsPanel() {
  const all = S.referrals || [], fresh = all.filter((r) => r.status === "new");
  const opt = S.referralOptions || { need: {}, from: {} };
  return `<section class="panel" aria-label="New referrals">
    <div class="panel-h"><h2>New referrals</h2><span class="sub">${fresh.length ? `${fresh.length} to look at` : "All dealt with"}</span></div>
    <p class="panel-note">From the referral form on your website, instead of emails and documents. Accepting one makes the patient record and puts them on the waiting list.</p>
    <div style="padding:0 18px 8px"><button class="btn secondary sm" type="button" data-act="referlink">${icon("qr")}Share the referral form</button></div>
    ${fresh.length ? `<ul class="recalls">${fresh.map((r) => `<li><div style="min-width:0"><div class="nm">${esc(r.name)}${r.urgent ? ` <span class="badge b-crit">Sight changed</span>` : ""}</div>
      <div class="meta"><span>${esc(opt.need[r.need] || r.need)}</span><span>${esc(r.pc)}</span><span>${esc((opt.from[r.fromKind] || "").replace(/^(A|The) /, ""))} · ${esc(r.at)}</span></div></div>
      <div class="ra"><button class="btn secondary sm" type="button" data-act="referral" data-id="${r.id}">Open</button></div></li>`).join("")}</ul>` : ""}
  </section>`;
}
function referralDrawer(d) {
  const r = (S.referrals || []).find((x) => x.id === d.id);
  if (!r) return "";
  const o = S.referralOptions, row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : "";
  const born = r.dob ? new Date(r.dob).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
  return `<div class="drawer-h"><div><div class="caps">Referral · ${esc(r.at)} · ${esc(o.from[r.fromKind])}</div><h2 style="margin-top:6px">${esc(r.name)}</h2></div>${closeX}</div>
    <div class="drawer-b">
      ${r.urgent ? `<div class="callout apricot" style="margin-bottom:14px">${icon("bolt")}<div><b>Sight has changed suddenly</b><div style="margin-top:2px">Call today. If it's sudden loss of sight, flashes or a painful red eye, they need NHS 111 or A&amp;E, not a home visit. The form told them so.</div></div></div>` : ""}
      <dl class="kv">${row("Needs", esc(o.need[r.need]))}${row("Born", esc(born))}${row("Address", esc(r.addr + ", " + r.pc))}${row("Phone", r.phone ? `<span class="mono">${esc(r.phone)}</span>` : "None given")}
        ${row("Home visit because", esc(r.eligibility))}${row("NHS entitlement", esc(r.entitlement.map((k) => o.entitlement[k]).join(", ") || "None ticked"))}
        ${row("Home", esc(META.avail[r.avail]))}${r.fromKind !== "self" ? row("Referred by", esc([r.fromName, r.fromPhone].filter(Boolean).join(", "))) : ""}${row("Notes", esc(r.notes || ""))}</dl>
      <div class="hr" style="margin:18px 0"></div>
      <div class="row2"><div class="field"><label for="rf-type">Waiting list for</label><select class="input" id="rf-type">${Object.entries(TYPES_NOW()).map(([k, v]) => `<option value="${k}" ${k === r.need ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></div>
        <div class="field"><label for="rf-prio">Priority</label><select class="input" id="rf-prio">${Object.entries(META.prio).map(([k, v]) => `<option value="${k}" ${k === (r.urgent ? "urgent" : "routine") ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></div></div>
      ${d.dup ? `<div class="err" role="alert">${esc(d.dup)}</div>` : ""}
      <details style="margin-top:14px"><summary class="muted" style="font-size:13.5px;cursor:pointer">Decline instead</summary>
        <div class="field" style="margin-top:10px"><label for="rf-why">Reason (kept on the referral)</label><input class="input" id="rf-why" placeholder="e.g. Can get to a practice, so not eligible for a home visit"></div>
        <button class="btn danger sm" type="button" data-act="ref-decline" data-id="${r.id}">Decline referral</button></details>
    </div>
    <div class="drawer-f"><button class="btn ghost" type="button" data-act="close">Later</button><button class="btn" type="button" data-act="ref-accept" data-id="${r.id}" data-anyway="${d.dup ? "1" : "0"}">${icon("check")}${d.dup ? "Accept anyway" : "Accept and add to the waiting list"}</button></div>`;
}
/** What the office must do in PCSE Online for NHS sight tests: lodge a notification for each new one, cancel it for each cancelled one. */
function pcsePanel() {
  const list = S.pcse || [], todo = list.filter((t) => t.status === "todo");
  if (!list.length) return "";
  return `<section class="panel" aria-label="PCSE notifications">
    <div class="panel-h"><h2>PCSE notifications</h2><span class="sub">${todo.length ? `${todo.length} to do` : "All done"}</span></div>
    <p class="panel-note">NHS sight tests at home need a notification to PCSE: 48 hours ahead, or 3 weeks for 3 or more at one address. <a href="#/pvn">Open PCSE notices</a> for the deadlines and every field PCSE Online asks for.</p>
    <div class="soon-row" style="padding:0 18px 8px">${soon("pcse-online", "Send to PCSE automatically", "send")}</div>
    <ul class="recalls">${list.map((t) => `<li>
      <div style="min-width:0"><div class="nm">${t.action === "lodge" ? "Lodge" : "Cancel"}: ${esc(t.name)}</div><div class="meta"><span>NHS sight test, ${esc(dayName(t.day))} ${hm(t.start)}</span>${t.action === "lodge" && t.status === "todo" ? `<span class="late">Lodge by ${esc(t.lodgeBy)}</span>` : ""}</div></div>
      <div class="ra">${t.status === "done" ? `<span class="badge b-ok">Done</span>` : `<button class="btn secondary sm" type="button" data-act="pcse-done" data-id="${t.id}">${icon("check")}Done</button>`}</div></li>`).join("")}</ul>
  </section>`;
}
/** Recalls due: they're already in the refill pool; the office can also text them the booking page. */
function recallsPanel() {
  const due = (S.recalls || []).filter((r) => r.status !== "dismissed");
  if (!due.length) return "";
  const when = (d) => d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : d === 0 ? "due today" : `due in ${d} day${d === 1 ? "" : "s"}`;
  return `<section class="panel" aria-label="Recalls">
    <div class="panel-h"><h2>Recalls</h2><span class="sub">In the refill pool</span></div>
    <p class="panel-note">Patients due a sight test are offered cancelled visits near them, 48 hours or more ahead so PCSE can be told. You can also text them your booking page.</p>
    <p class="panel-note" style="padding-top:0">${S.settings.autoRecalls ? `${icon("check")} Recall texts go out automatically at ${hm(S.settings.recallAt)}. Patients who'd rather be phoned stay here for you to call.` : `Automatic recall texts are off.`} <a href="#/settings/refill">Change</a></p>
    <ul class="recalls">${due.map((r) => { const p = pat(r.patientId); return `<li>
      <div style="min-width:0"><div class="nm">${esc(p ? p.name : "")}</div><div class="meta"><span>${esc(r.reason)}</span><span class="${r.dueDay < 0 ? "late" : ""}">${when(r.dueDay)}</span>${p ? `<span>${district(p.pc)}</span>` : ""}</div></div>
      <div class="ra">${r.status === "booked" ? `<span class="badge b-ok">Booked</span>`
        : `${r.status === "texted" ? `<span class="badge b-plain">Texted ${esc(String(r.textedAt || "").slice(0, 5))}</span>` : `<button class="btn secondary sm" type="button" data-act="recall-text" data-id="${r.id}">${icon("send")}Text link</button>`}
           <button class="icon-btn sm" type="button" data-act="recall-dismiss" data-id="${r.id}" title="Remove from recalls" aria-label="Remove ${esc(p ? p.name : "")} from recalls">${icon("x")}</button>`}</div></li>`; }).join("")}</ul>
  </section>`;
}
/** Day-before reminders: each one invites a CANCEL reply, which refills the slot a day ahead. */
function remindersPanel() {
  const st = S.settings, tomorrow = S.appts.filter((a) => (a.day || 0) === 1 && a.status === "booked");
  const sent = tomorrow.filter((a) => a.reminded).length, left = tomorrow.length - sent;
  return `<section class="panel" aria-label="Reminders">
    <div class="panel-h"><h2>Reminders</h2><span class="sub">${st.reminders ? "Day before, at " + hm(st.reminderAt) : "Off"}</span></div>
    <div class="remind">
      <p><b>${tomorrow.length} visits tomorrow</b> (${esc(dayName(1))}) · ${sent ? `${sent} reminded` : "none reminded yet"}. Each text invites a CANCEL reply, which frees the slot and offers it to the waiting list automatically.</p>
      <button class="btn sm ${left ? "" : "secondary"}" type="button" data-act="send-reminders" ${left ? "" : "disabled"}>${icon("send")}${left ? `Send ${left} reminder${left === 1 ? "" : "s"} now` : "All reminded"}</button>
    </div>
  </section>`;
}
function wlItem(w, i) {
  const p = pat(w.patientId), t = T(w.type);
  const badge = w.status === "booked" ? `<span class="badge b-ok">Booked</span>`
    : w.status === "offered" ? `<span class="badge b-apricot">Offered</span>`
    : w.source === "recall" ? `<span class="badge b-forest">Recall</span>`
    : `<span class="badge ${w.prio === "urgent" ? "b-crit" : w.prio === "soon" ? "b-warn" : "b-plain"}">${META.prio[w.prio].label}</span>`;
  return `<li class="${w.status === "booked" ? "booked" : ""}"><span class="pos">${w.status === "booked" ? icon("check") : i + 1}</span>
    <div style="min-width:0"><div class="nm">${esc(p.name)}</div>
      <div class="meta"><span>${t.name}</span><span>${district(p.pc)}</span><span>${META.avail[w.avail]}</span>${w.shortNotice ? "" : "<span>Needs 24h notice</span>"}<span>${w.source === "recall" ? esc(w.note || "Recall due") : w.days + " days waiting"}</span></div></div>
    ${badge}</li>`;
}
function smsBubble(m) {
  const cls = m.dir === "in" ? "in" : (m.toClin ? "clin" : "");
  const who = m.dir === "in" ? `From ${esc(m.name)}` : `To ${esc(m.name)}`;
  return `<div class="sms ${cls}"><div class="who">${who} · <span class="mono">${esc(String(m.at || "").slice(0, 5))}</span></div><div class="bub">${esc(m.body)}</div></div>`;
}
/** The diary's week strip: the five weekdays of the week shown, previous and next week, back to today, and a date picker
 *  that reaches as far ahead as the office can book. Closed days (bank holidays, the practice's own) can't be opened. */
function dayNav() {
  if (UI.wk == null) UI.wk = weekStart(UI.day || 0);
  const minWk = weekStart(-14), maxWk = weekStart(S.cal.bookAheadDays), first = calDay(-14), last = calDay(S.cal.bookAheadDays);
  const tab = (d) => {
    const x = calDay(d); if (!x) return "";
    const lab = d === 0 ? "Today" : x.label.slice(0, x.label.lastIndexOf(" "));
    if (!x.open) return `<button type="button" disabled title="Closed: ${esc(x.why)}" aria-label="${esc(x.long)}: closed, ${esc(x.why)}">${lab}<span class="mono">–</span></button>`;
    return `<button type="button" role="tab" data-act="day" data-v="${d}" aria-pressed="${UI.view === "day" && UI.day === d}" aria-label="${esc(x.long)}">${lab}<span class="mono">${S.appts.filter((a) => active(a) && (a.day || 0) === d).length}</span></button>`;
  };
  return `<div class="day-nav">
    <button class="icon-btn sm" type="button" data-act="wk" data-v="-7" ${UI.wk <= minWk ? "disabled" : ""} aria-label="Previous week">${icon("back")}</button>
    <div class="seg day-tabs" role="tablist" aria-label="Choose a day">${[0, 1, 2, 3, 4].map((i) => tab(UI.wk + i)).join("")}<button type="button" data-act="week" aria-pressed="${UI.view === "week"}">${icon("cal")}Week</button></div>
    <button class="icon-btn sm" type="button" data-act="wk" data-v="7" ${UI.wk >= maxWk ? "disabled" : ""} aria-label="Next week">${icon("next")}</button>
    ${UI.wk !== weekStart(0) ? `<button class="btn ghost sm" type="button" data-act="wk-today">Today</button>` : ""}
    <input class="input date-jump" type="date" id="jump-date" min="${first ? first.iso : ""}" max="${last ? last.iso : ""}" value="${(calDay(UI.day) || {}).iso || ""}" aria-label="Go to a date">
  </div>`;
}

/** Clinicians on the diary: everyone working, plus anyone who has left but still has visits that day. */
const onBoard = (day) => S.clinicians.filter((c) => c.active !== false || S.appts.some((a) => a.clinicianId === c.id && (a.day || 0) === day && active(a)));
function board(nowM) {
  const PX = 1.4, DS = dayS(), DE = dayE(), H = (DE - DS) * PX;
  const team = onBoard(UI.day);
  let ticks = "";
  for (let m = DS; m <= DE; m += 60) ticks += `<div class="tick mono" style="top:${(m - DS) * PX}px">${hm(m)}</div>`;
  if ((DE - DS) % 60) ticks += `<div class="tick mono" style="top:${H}px">${hm(DE)}</div>`; // the end of the day, e.g. 17:30
  const nowY = Math.max(0, Math.min(H, (nowM - DS) * PX));
  const lanes = team.map((c, ci) => {
    const list = dayAppts(c.id, UI.day);
    // Outside their working hours (or a day off) is shaded, so nobody books into it by eye.
    const h = hoursFor(c, UI.day), shut = calDay(UI.day) && !calDay(UI.day).open;
    const off = !h ? `<div class="off-hours" style="top:0;height:${H}px"><span>${shut ? "Closed" : "Day off"}</span></div>`
      : (h[0] > DS ? `<div class="off-hours" style="top:0;height:${(h[0] - DS) * PX}px"></div>` : "") + (h[1] < DE ? `<div class="off-hours" style="top:${(h[1] - DS) * PX}px;height:${(DE - h[1]) * PX}px"></div>` : "");
    const blocks = list.map((a) => {
      const p = pat(a.patientId), t = T(a.type), top = (a.start - DS) * PX, h = Math.max(t.dur * PX - 4, 36);
      const cls = a.moved ? "moved" : a.bookedMin != null && a.status === "booked" ? "fresh" : a.status;
      const drive = a.drive >= 10 ? `<div class="drive" style="top:${top - a.drive * PX + 3}px">${icon("car")}${a.drive} min</div>` : "";
      const head = h < 52
        ? `<span class="row1"><span class="tm">${hm(a.start)}</span><span class="pn">${esc(p.name)}</span></span>`
        : `<span class="tm">${hm(a.start)}–${hm(a.start + t.dur)}</span><span class="pn">${esc(p.name)}</span>`;
      const extra = (h > 62 ? `<span class="ty">${t.name}</span>` : "")
        + (h > 84 && a.moved ? `<span class="badge b-apricot" style="margin-top:4px">${icon("bolt")}Moved forward</span>` : "")
        + (h > 60 && !a.moved && a.bookedMin != null ? `<span class="badge b-forest" style="margin-top:4px">${icon("plus")}New booking</span>` : "")
        + (h > 84 && a.status === "enroute" ? `<span class="badge b-warn" style="margin-top:4px">${icon("car")}On the way</span>` : "")
        + (a.status === "missed" ? `<span class="badge b-plain" style="margin-top:4px">Not seen</span>` : "");
      const tc = countOf(a) < 1 && ["booked", "enroute"].includes(a.status) ? `<span class="tcount ${countOf(a) <= 0.25 ? "low" : ""}" title="True count ${fmtCount(countOf(a))}: may not be in">${fmtCount(countOf(a))}</span>` : "";
      return `${drive}<button class="blk ${cls}" type="button" data-act="open-appt" data-id="${a.id}" style="top:${top}px;height:${h}px" aria-label="${esc(p.name)} at ${hm(a.start)}${tc ? `, true count ${fmtCount(countOf(a))}` : ""}">${tc}${head}${extra}</button>`;
    }).join("");
    const filled = new Set(list.map((a) => a.start));
    const gaps = S.appts.filter((a) => a.clinicianId === c.id && (a.day || 0) === UI.day && a.status === "cancelled" && !filled.has(a.start)).map((a) => {
      const t = T(a.type), offers = S.offers.filter((o) => o.slot_id === a.id);
      const label = offers.length ? `Offer out · replies close ${esc(offers[0].deadline)}` : `Open slot · ${money(S.metrics.fee)} unfilled`;
      return `<button class="blk gap ${offers.length ? "offering" : ""}" type="button" data-act="gap" data-id="${a.id}" style="top:${(a.start - DS) * PX}px;height:${t.dur * PX - 4}px" aria-label="Free slot at ${hm(a.start)}: choose who fills it"><span class="tm">${hm(a.start)}</span><span class="ty">${label}</span></button>`;
    }).join("");
    return `<div class="lane" style="height:${H}px;background-size:100% ${60 * PX}px">${off}${blocks}${gaps}${UI.day === 0 ? `<div class="now" data-now style="top:${nowY}px">${ci === 0 ? `<span class="now-label mono" data-clock>${hm(nowM)}</span>` : ""}</div>` : ""}</div>`;
  }).join("");
  const heads = team.map((c) => `<div class="col-h"><span class="avatar sm" style="background:${c.color}">${initials(c.name)}</span><div style="min-width:0;flex:1"><div class="nm">${esc(c.name)}</div><div class="rl">${esc(c.role)} · ${esc(c.areaName)}</div>${hoursFor(c, UI.day) ? strengthTag(c.id, UI.day) : ""}</div><button class="icon-btn sm" type="button" data-act="route" data-c="${c.id}" title="${esc(c.first)}'s route on a map" aria-label="${esc(c.first)}'s route on a map">${icon("pin")}</button></div>`).join("");
  return `<div class="board" style="grid-template-columns:56px repeat(${team.length},minmax(210px,1fr))"><div class="col-h"></div>${heads}<div class="times" style="height:${H}px">${ticks}</div>${lanes}</div>`;
}

/* Week at a glance: each clinician's load per day; click a day to open it. */
function weekView() {
  const WORK = dayE() - dayS();
  const cells = S.clinicians.filter((c) => c.active !== false).map((c) => `<div class="wk-row"><div class="col-h" style="border:0;padding:0"><span class="avatar sm" style="background:${c.color}">${initials(c.name)}</span><div><div class="nm">${esc(c.first || c.name)}</div><div class="rl">${esc(c.areaName)}</div></div></div>
    ${[0, 1, 2, 3, 4].map((k) => {
      const i = UI.wk + k, x = calDay(i), d = x ? x.label : "";
      const h = hoursFor(c, i);
      const list = dayAppts(c.id, i), mins = list.reduce((t, a) => t + T(a.type).dur + (a.drive || 0), 0), pct = h ? Math.min(100, Math.round(mins / (h[1] - h[0]) * 100)) : 0;
      if (x && !x.open && !list.length) return `<div class="wk-cell off"><span class="wk-sub">Closed: ${esc(x.why)}</span></div>`;
      if (!h && !list.length) return `<div class="wk-cell off"><span class="wk-sub">Day off</span></div>`;
      const fresh = list.filter((a) => a.moved || a.bookedMin != null).length;
      return `<button class="wk-cell" type="button" data-act="day" data-v="${i}" aria-label="${esc(c.name)}, ${d}: ${list.length} visits">
        <span class="wk-n">${list.length}<small> visits</small></span>
        <span class="wk-bar"><i style="width:${pct}%"></i></span>
        <span class="wk-sub">${pct}% of the day booked${fresh ? ` · ${fresh} new` : ""}</span>${list.length ? strengthTag(c.id, i) : ""}</button>`;
    }).join("")}</div>`).join("");
  return `<div class="week" data-scroll="week"><div class="wk-row wk-head"><div></div>${[0, 1, 2, 3, 4].map((k) => { const i = UI.wk + k; return `<div class="caps">${i === 0 ? "Today" : esc(dayName(i))}</div>`; }).join("")}</div>${cells}</div>`;
}

/* ---------- Clinician ---------- */
function clinView() {
  const c = S.clinicians[0];
  let body;
  if (UI.pid && UI.rec) body = record(UI.rec);
  else if (UI.tab === "patients") body = patientsTab(c);
  else if (UI.tab === "msgs") body = msgsTab(c);
  else body = todayTab(c);
  const unread = S.messages.filter((m) => m.toClin === c.id && !m.read).length;
  return `<div class="shell cl"><div class="clin-stage">
    <div class="clin-side"><div class="caps">Clinician view</div><h2 style="margin-top:8px">${esc(c.first)}'s phone</h2>
      <p>What a clinician carries on the round, built for one hand between visits.</p>
      <ul>
        <li>${icon("cal")}<span>Today's visits in order, with drive times</span></li>
        <li>${icon("note")}<span>Patient record, prescription and one-tap notes</span></li>
        <li>${icon("car")}<span>"On my way" texts the patient automatically</span></li>
        <li>${icon("bolt")}<span>Diary changes from the office arrive live</span></li>
        <li>${icon("shield")}<span>Keeps working without signal</span></li>
      </ul>
</div>
    <div class="phone">
      <div class="ph-scroll" id="ph-scroll" data-scroll="phone">${UI.offline ? `<div class="offline-bar" role="status">${icon("bolt")}<span><b>No signal.</b> Your round and records are saved on this phone.${outbox.length ? ` ${outbox.length} change${outbox.length === 1 ? "" : "s"} waiting to sync.` : ""}</span></div>` : ""}${body}</div>
      <nav class="ph-tabs" aria-label="Clinician sections">
        <button type="button" data-act="tab" data-v="today" aria-current="${!UI.pid && UI.tab === "today" ? "page" : "false"}">${icon("cal")}Today</button>
        <button type="button" data-act="tab" data-v="patients" aria-current="${UI.tab === "patients" || UI.pid ? "page" : "false"}">${icon("users")}Patients</button>
        <button type="button" data-act="tab" data-v="msgs" aria-current="${!UI.pid && UI.tab === "msgs" ? "page" : "false"}">${icon("msg")}Messages${unread ? `<span class="dot">${unread}</span>` : ""}</button>
      </nav>
    </div><div></div></div></div>`;
}
/** The PCSE notification for an NHS sight test, as the clinician needs it before testing. */
const pvnChip = (a) => !a || !T(a.type).pvn || a.status === "done" || a.status === "missed" ? ""
  : a.pvn === "lodged" ? `<span class="pvn ok">${icon("check")}PCSE notified</span>`
  : `<span class="pvn bad">${icon("x")}PCSE not notified yet: check with the office before testing</span>`;
/** The clinician couldn't do the visit: why, and whether they go back on the waiting list. */
const NOT_DONE_REASONS = [["nobody", "Nobody in"], ["unwell", "Patient unwell"], ["declined", "Patient declined"], ["access", "Couldn't get in"]];
const canNotDo = (a) => a && (a.status === "enroute" || a.status === "live" || (a.status === "booked" && (a.day || 0) === 0 && a.start <= demoNow()));
function notDoneForm(a) {
  return `<form class="nd-form" id="nd-form" data-id="${a.id}" novalidate>
    <div class="nd-h"><b>Couldn't do this visit?</b><button class="icon-btn" type="button" data-act="nd-close" aria-label="Close">${icon("x")}</button></div>
    <div class="nd-opts" role="radiogroup" aria-label="What happened">${NOT_DONE_REASONS.map(([k, l], i) => `<label class="nd-opt"><input type="radio" name="nd-reason" value="${k}" ${i === 0 ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>
    <label class="chk" style="margin-top:10px"><input type="checkbox" id="nd-rebook" checked><span>Put them back on the waiting list</span></label>
    <textarea class="note" id="nd-note" rows="2" placeholder="Anything the office should know (optional)"></textarea>
    <button class="btn block" type="submit" style="margin-top:10px">${icon("check")}Tell the office</button>
    ${T(a.type).pvn ? `<p class="nd-small">PCSE's notification is withdrawn, as no sight test happened.</p>` : ""}
  </form>`;
}
function nextAction(a) {
  if (a.status === "booked") return { v: "enroute", label: "On my way", ic: "car" };
  if (a.status === "enroute") return { v: "live", label: "I've arrived", ic: "pin" };
  if (a.status === "live") return { v: "done", label: "Complete visit", ic: "check" };
  return null;
}
function todayTab(c) {
  const finished = (a) => a.status === "done" || a.status === "missed";
  const list = dayAppts(c.id), done = list.filter(finished).length;
  const moved = list.find((a) => (a.moved || a.bookedMin != null) && !a.seen);
  const nxt = list.find((a) => !finished(a));
  const rest = list.filter((a) => a !== nxt);
  const switcher = !isOffice() ? "" : `<span class="preview-tag">${S.signedInAs.dual && S.user.id === S.signedInAs.id ? "Your round" : "Office preview"}</span><select class="who-select" id="me" aria-label="Switch clinician">${clinUsers().map((u) => `<option value="${u.id}" ${u.id === "u-" + c.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>`;
  let hero = "";
  if (nxt) {
    const p = pat(nxt.patientId), t = T(nxt.type), act = nextAction(nxt);
    hero = `<div class="next">
      <div class="nt"><span class="caps" style="color:inherit;opacity:.75">${nxt.status === "live" ? "With patient now" : nxt.status === "enroute" ? "On the way" : "Next visit"}</span>${nxt.moved ? `<span class="badge b-apricot">${icon("bolt")}Moved forward</span>` : ""}</div>
      <div class="nt" style="align-items:flex-end"><div><div class="time">${hm(nxt.start)}</div><div class="pn" style="margin-top:6px">${esc(p.name)}</div></div><span class="tag-chip">${t.name}</span></div>
      <div class="ad">${icon("pin")}${esc(p.addr)}, ${esc(p.pc)}</div>
      ${p.alerts.length ? `<div class="ad">${icon("users")}${esc(p.alerts[0])}</div>` : ""}
      ${pvnChip(nxt) ? `<div class="ad">${pvnChip(nxt)}</div>` : ""}
      ${UI.nd === nxt.id ? notDoneForm(nxt) : `<div class="acts">${act ? `<button class="btn light" type="button" data-act="status" data-v="${act.v}" data-id="${nxt.id}">${icon(act.ic)}${act.label}</button>` : ""}<button class="btn outline" type="button" data-act="open-p" data-id="${p.id}" data-appt="${nxt.id}">Record</button></div>
      ${canNotDo(nxt) ? `<button class="nd-link" type="button" data-act="nd-open" data-id="${nxt.id}">Couldn't do this visit?</button>` : ""}`}
    </div>`;
  }
  const cards = rest.map((a, i) => {
    const p = pat(a.patientId), t = T(a.type);
    const st = a.status === "done" ? `<span class="badge b-plain">Done</span>` : a.status === "missed" ? `<span class="badge b-plain">Not seen</span>` : a.moved ? `<span class="badge b-apricot">${icon("bolt")}Moved</span>` : a.bookedMin != null ? `<span class="badge b-forest">${icon("plus")}New</span>` : "";
    return `${a.drive && i > 0 && a.status !== "done" ? `<div class="drive-row">${icon("car")}${a.drive} min drive</div>` : ""}
      <button class="v ${a.moved ? "moved" : a.status === "done" ? "done" : ""}" type="button" data-act="open-p" data-id="${p.id}" data-appt="${a.id}">
        <div class="tl"><span class="t">${hm(a.start)}</span><span class="ln"></span></div>
        <div class="card"><div class="row"><span class="type-chip">${t.name}</span>${st}</div>
          <div class="pn">${esc(p.name)}</div>
          <div class="ad">${icon("pin")}<span>${esc(p.addr)}, ${esc(p.pc)}</span></div>
          ${p.alerts.length && a.status !== "done" ? `<div class="ad" style="color:var(--warn)">${icon("users")}<span>${esc(p.alerts[0])}</span></div>` : ""}
          ${pvnChip(a) ? `<div class="ad">${pvnChip(a)}</div>` : ""}
          ${countOf(a) <= 0.5 && ["booked", "enroute"].includes(a.status) ? `<div class="ad" style="color:var(--apricot-ink, #9a4a12)">${icon("phone")}<span>Ring first: they may not be in</span></div>` : ""}
        </div></button>`;
  }).join("");
  return `<div class="ph-head"><div><div class="caps">${esc(dayName(0))} · <span data-clock>${hm(demoNow())}</span></div><h2 style="margin-top:6px">Morning, ${esc(c.first)}</h2></div>${switcher}</div>
    <div style="display:flex;justify-content:space-between;font-size:13px"><span class="muted">${done} of ${list.length} visits done</span><span class="muted">${esc(c.areaName)}</span></div>
    <div class="progress"><i style="width:${list.length ? done / list.length * 100 : 0}%"></i></div>
    ${moved ? `<div class="banner">${icon("bolt")}<div><b>${moved.moved ? "Your diary changed" : "New visit added"}</b>${esc(moved.note)}</div></div>` : ""}
    ${hero}
    ${list.length ? `<div class="route-card">${UI.myRoute ? routeMap(UI.myRoute, { height: 320 }) + routeSummary(UI.myRoute) : ""}
      <button class="btn secondary sm block" type="button" data-act="my-route">${icon("pin")}${UI.myRoute ? "Hide today's route" : "Today's route on a map"}</button></div>` : ""}
    ${rest.length ? `<div class="section-t"><span class="caps">Rest of today</span></div><div class="visits">${cards}</div>` : ""}
    ${!list.length ? `<div class="empty"><b>No visits today</b>Your round will appear here.</div>` : ""}`;
}
function patientsTab(c) {
  const q = UI.q.toLowerCase();
  const list = S.patients.filter((p) => !q || p.name.toLowerCase().includes(q) || p.pc.toLowerCase().includes(q));
  return `<div class="ph-head"><div><div class="caps">${esc(c.areaName)}</div><h2 style="margin-top:6px">Patients</h2></div></div>
    <input class="input search" id="psearch" data-keep type="search" placeholder="Search by name or postcode" value="${esc(UI.q)}" aria-label="Search patients">
    <div class="plist">${list.map((p) => `<button type="button" data-act="open-p" data-id="${p.id}"><div><div style="font-weight:600">${esc(p.name)}</div><div class="muted" style="font-size:12.5px">${esc(p.addr)}, ${esc(p.pc)}</div></div>${icon("next")}</button>`).join("") || `<div class="empty"><b>No patients match</b>Try a surname or a postcode like LS6.</div>`}</div>`;
}
function msgsTab() {
  if (S.messages.some((m) => m.toClin && !m.read)) api("POST", "/api/messages/read").then(refetch).catch(() => {});
  return `<div class="ph-head"><div><div class="caps">From the office</div><h2 style="margin-top:6px">Messages</h2></div></div>
    ${S.messages.length ? `<div class="feed" style="padding:0;max-height:none">${S.messages.map(smsBubble).join("")}</div>` : `<div class="empty"><b>Nothing yet</b>Diary changes and texts sent on your behalf appear here.</div>`}`;
}
/** The last prescription, laid out the way it's written on a GOS form: right eye first. */
function prescription(rx) {
  const row = (eye, e) => `<tr><th scope="row">${eye}</th>${["sph", "cyl", "axis", "add", "va"].map((k) => `<td>${esc(e[k] || "–")}</td>`).join("")}</tr>`;
  return `<table class="rx"><thead><tr><th></th><th scope="col">Sph</th><th scope="col">Cyl</th><th scope="col">Axis</th><th scope="col">Add</th><th scope="col">VA</th></tr></thead>
    <tbody>${row("R", rx.R)}${row("L", rx.L)}</tbody></table><div class="rx-leg">Tested ${esc(rx.date)}</div>`;
}
function record(p) {
  const upcoming = S.appts.filter((x) => x.patientId === p.id && active(x) && x.status !== "done").sort((x, y) => (x.day || 0) - (y.day || 0) || x.start - y.start);
  const a = upcoming.find((x) => (x.day || 0) === 0) || null, later = upcoming.find((x) => (x.day || 0) > 0);
  const t = a ? T(a.type) : null, act = a && nextAction(a);
  const maps = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(p.addr + ", " + p.pc);
  return `<button class="back" type="button" data-act="back">${icon("back")}Back</button>
    <div class="rec-h"><div class="caps">${a ? `${hm(a.start)} · ${t.name}` : "Patient record"}</div><h2 style="margin-top:6px">${esc(p.name)}</h2>${pvnChip(a) ? `<div style="margin-top:8px">${pvnChip(a)}</div>` : ""}
      <div class="sub">${p.age ? p.age + " years · " : ""}${esc(p.addr)}, ${esc(p.pc)}</div></div>
    <div class="tags"><span class="tag">${icon("msg")}Prefers: ${esc(p.contact)}</span>${p.alerts.map((x) => `<span class="tag alert">${esc(x)}</span>`).join("")}</div>
    <div class="quick">
      <a href="${maps}" target="_blank" rel="noopener">${icon("pin")}Directions</a>
      <a href="tel:${esc(String(p.phone || "").replace(/\s/g, ""))}">${icon("phone")}Call</a>
      <button type="button" data-act="focus-note">${icon("note")}Add note</button>
    </div>
    ${a && a.moved ? `<div class="banner">${icon("bolt")}<div><b>Moved forward today</b>${esc(a.note)}</div></div>` : ""}
    ${!a && later ? `<div class="callout forest" style="margin-top:12px">${icon("cal")}<div><b>Next visit: ${esc(dayName(later.day))} at ${hm(later.start)}</b><div style="margin-top:2px">${esc(T(later.type).name)}</div></div></div>` : ""}
    <div class="sec"><h3>Visit notes ${a && a.status === "live" ? `<span class="badge b-ok">In progress</span>` : ""}</h3>
      <div class="chips">${["Vision recorded", "Pressures checked", "Fundus photos taken", "Frames chosen", "GOS 6 signed", "Glasses fitted & adjusted", "Referred to GP", "Recall in 12 months"].map((c) => `<button type="button" data-act="chip">${c}</button>`).join("")}</div>
      <textarea class="note" id="note-${p.id}" data-keep placeholder="What did you do on this visit?"></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn sm" type="button" data-act="save-note" data-id="${p.id}">${icon("check")}Save to record</button></div>
    </div>
    <div class="sec"><h3>Prescription</h3>${p.rx ? prescription(p.rx) : `<p class="muted" style="margin:0;font-size:13.5px">No prescription on record yet. It's added after the sight test.</p>`}
</div>
    <div class="sec"><h3>Details</h3><dl class="kv"><dt>Phone</dt><dd class="mono">${esc(p.phone)}</dd>${p.rep ? `<dt>Next of kin</dt><dd>${esc(p.rep)}</dd>` : ""}${p.poa ? `<dt>Power of attorney</dt><dd>${esc(p.poa)}</dd>` : ""}<dt>Talk to family?</dt><dd>${p.share === "yes" ? "Yes" : p.share === "no" ? `<span class="late">No: only the patient</span>` : "Not asked yet"}</dd><dt>Glasses</dt><dd>${esc(p.specs)}</dd>${p.dob ? `<dt>Born</dt><dd>${esc(new Date(p.dob).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }))}</dd>` : ""}${p.lastTest ? `<dt>Last sight test</dt><dd>${esc(new Date(p.lastTest).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }))} · ${p.recallMonths || 12}-month recall</dd>` : ""}${p.nhsFrom ? `<dt>Next NHS test</dt><dd>${p.nhsFrom.day > 0 ? `Not before <b>${esc(p.nhsFrom.label)}</b>` : `Due now (from ${esc(p.nhsFrom.label)})`}</dd>` : ""}<dt>Home visit reason</dt><dd>${p.eligibility ? esc(p.eligibility) : `<span class="late">Not recorded</span>`}</dd>${p.rep ? `<dt>Next of kin</dt><dd>${esc(p.rep)}</dd>` : ""}${p.email ? `<dt>Email</dt><dd>${esc(p.email)}</dd>` : ""}<dt>Area</dt><dd>${esc(p.pc)}</dd></dl></div>
    <div class="sec"><h3>History</h3>${p.history.length ? `<ul class="hist">${p.history.map((h) => `<li><div><div class="d">${esc(h.label)}${h.by ? " · " + esc(h.by) : ""}</div>${esc(h.body)}</div></li>`).join("")}</ul>` : `<p class="muted" style="margin:0;font-size:13.5px">First visit.</p>`}</div>
    ${a && UI.nd === a.id ? `<div class="sec">${notDoneForm(a)}</div>` : ""}
    ${a ? `<div class="actionbar">${a.status === "booked" ? `<button class="btn danger" type="button" data-act="open-appt" data-id="${a.id}">${icon("x")}Cancel</button>` : ""}${canNotDo(a) && UI.nd !== a.id ? `<button class="btn secondary" type="button" data-act="nd-open" data-id="${a.id}">Couldn't do it</button>` : ""}${act ? `<button class="btn" type="button" data-act="status" data-v="${act.v}" data-id="${a.id}">${icon(act.ic)}${act.label}</button>` : ""}</div>` : ""}`;
}

/* ============ Office pages: a menu down the left, and a page for each part of the practice ============ */
// The address says which page is open (#/patients, #/patients/<id>, #/team, #/team/clin/<id>), so the back button,
// refreshing and bookmarks all work. Quick actions (a visit, a lead, booking) stay as side panels over the page.
function parseRoute() {
  const [page = "", id, sub] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (page === "patients" && id === "new") return { page: "newpatient" };
  if (page === "patients" && id) return { page: "patient", id, tab: sub || "overview" };
  if (page === "patients") return { page: "patients" };
  if (page === "team" && id) return { page: "person", k: id === "staff" ? "staff" : "clin", id: sub || "new" };
  if (page === "team") return { page: "team" };
  if (page === "leads" && id) return { page: "lead", id };
  if (["routes", "mileage", "invoices", "import", "coming-soon", "calls", "pvn", "pilot", "opticabase"].includes(page)) return { page };
  if (page === "leads") return { page: "leads" };
  if (page === "settings") return { page: "settings", sec: SET_SECS.some((x) => x.k === id) ? id : "practice" };
  return { page: "today" };
}
const go = (path) => { location.hash = "/" + path; };
/** Keep the open page's own data (a patient's record, the team) in step with the address. */
async function syncPage() {
  const r = UI.route;
  if (!S || !isAdmin()) { UI.pg = null; return; }
  if (r.page === "patient") {
    const fresh = !UI.pg || UI.pg.kind !== "patient" || UI.pg.id !== r.id;
    if (fresh) UI.pg = { kind: "patient", id: r.id, rec: null, edit: false };
    UI.pg.tab = r.tab;
    if (!UI.pg.edit) UI.pg.rec = await api("GET", `/api/patients/${encodeURIComponent(r.id)}${fresh ? "" : "?background=1"}`).catch(() => UI.pg.rec || { missing: true });
  } else if (r.page === "settings") {
    if (!UI.pg || UI.pg.kind !== "settings") UI.pg = { kind: "settings", edit: true, msgs: null };
    if (r.sec === "facebook") UI.pg.conn = await api("GET", "/api/leads/connection").catch(() => UI.pg.conn);
    if (r.sec === "hours") UI.pg.team = await api("GET", "/api/team").catch(() => UI.pg.team);
    if (r.sec === "messages") UI.pg.msgs = await api("GET", "/api/settings/messages").catch(() => UI.pg.msgs);
  } else if (r.page === "newpatient") {
    if (!UI.pg || UI.pg.kind !== "new") UI.pg = { kind: "new", edit: true, pre: UI.npPre || {} };
    UI.npPre = null;
  } else if (r.page === "routes") {
    if (!UI.pg || UI.pg.kind !== "plans") { UI.pg = { kind: "plans", day: UI.view === "week" ? 1 : UI.day, list: null }; setTimeout(() => loadPlans(UI.pg.day), 0); }
  } else if (r.page === "mileage") {
    UI.pg = { kind: "report", data: await api("GET", "/api/reports/week").catch(() => null) };
  } else if (r.page === "calls") {
    const keep = UI.pg && UI.pg.kind === "calls" ? UI.pg.stage : null;
    UI.pg = { kind: "calls", stage: keep, data: await api("GET", "/api/calls").catch(() => null) };
  } else if (r.page === "opticabase") {
    const keep = UI.pg && UI.pg.kind === "opticabase" ? UI.pg : null;
    UI.pg = { kind: "opticabase", tab: keep ? keep.tab : "todo", data: await api("GET", "/api/diary-changes").catch(() => (keep && keep.data) || null) };
  } else if (r.page === "pilot") {
    const keep = UI.pg && UI.pg.kind === "pilot" ? UI.pg : null;
    UI.pg = { kind: "pilot", edit: keep ? keep.edit : false, data: await api("GET", "/api/pilot").catch(() => (keep && keep.data) || null) };
    if (UI.pg.data && !UI.pg.data.config.start) UI.pg.edit = true;
  } else if (r.page === "pvn") {
    const keep = UI.pg && UI.pg.kind === "pvn" ? UI.pg.tab : null;
    UI.pg = { kind: "pvn", tab: keep, data: await api("GET", "/api/pvn").catch(() => (UI.pg && UI.pg.data) || null) };
  } else if (r.page === "invoices") {
    UI.pg = { kind: "invoices", data: await api("GET", "/api/invoices").catch(() => null) };
  } else if (r.page === "import") {
    if (!UI.pg || UI.pg.kind !== "import") { UI.pg = { kind: "import" }; UI.imp = {}; }
  } else if (r.page === "lead") {
    UI.pg = { kind: "lead", id: r.id };
  } else if (r.page === "team" || r.page === "person") {
    if (!UI.pg || UI.pg.kind !== "team") UI.pg = { kind: "team", data: null, edit: null };
    if (r.page === "team") UI.pg.invite = null; // a link is only shown on the page it was made from
    const edit = r.page === "person" ? { kind: r.k, id: r.id === "new" ? null : r.id } : null;
    const changed = JSON.stringify(edit) !== JSON.stringify(UI.pg.edit);
    UI.pg.edit = edit;
    if (changed || !edit || !UI.pg.data) UI.pg.data = await api("GET", "/api/team").catch(() => UI.pg.data);
  } else UI.pg = null;
}
/** A form on a page isn't redrawn by live updates, so nothing typed is lost. */
const pageEditing = () => !!(UI.pg && UI.pg.edit && document.querySelector("#app form"));
window.addEventListener("hashchange", async () => {
  UI.route = parseRoute();
  if (UI.drawer) closeDrawer();
  if (!S) return;
  if (UI.pg && UI.pg.kind === "team") UI.pg.edit = undefined; // the address decides
  await syncPage(); render();
  window.scrollTo({ top: 0 });
  const h = document.querySelector("#app h1"); if (h) h.focus({ preventScroll: true });
});
/** The drawer or the page a patient or team action belongs to. */
const ctx = (kind) => (UI.drawer && UI.drawer.kind === kind ? UI.drawer : UI.pg);
const rerender = (d) => (UI.drawer && UI.drawer === d ? renderDrawer() : render());

function officeShell() {
  const p = UI.route.page;
  const body = p === "patients" ? patientsPage() : p === "patient" ? patientPage() : p === "newpatient" ? newPatientPage() : p === "settings" ? settingsPage() : p === "leads" ? leadsPage() : p === "coming-soon" ? comingSoonPage() : p === "routes" ? toolPage("plans") : p === "mileage" ? toolPage("report") : p === "invoices" ? toolPage("invoices") : p === "import" ? toolPage("import") : p === "lead" ? leadPage() : p === "calls" ? callsPage() : p === "pvn" ? pvnPage() : p === "pilot" ? pilotPage() : p === "opticabase" ? opticabasePage() : p === "team" || p === "person" ? teamPage() : officeView();
  return `<div class="app-shell">${sideNav()}<div class="app-main">${body}</div></div>`;
}
function sideNav() {
  const p = UI.route.page;
  const on = (k) => k === p || (k === "patients" && (p === "patient" || p === "newpatient")) || (k === "team" && p === "person") || (k === "leads" && p === "lead");
  const needs = (S.leads || []).filter((l) => l.status === "new").length + (S.referrals || []).filter((r) => r.status === "new").length + (S.pcse || []).filter((t) => t.status === "todo").length;
  const link = (k, ic, label, count) => `<a class="nav-i" href="#/${k === "today" ? "" : k}" ${on(k) ? 'aria-current="page"' : ""}>${icon(ic)}<span class="nl">${label}</span>${count ? `<span class="nc">${count}</span>` : ""}</a>`;
  const act = (a, ic, label) => `<button class="nav-i" type="button" data-act="${a}">${icon(ic)}<span class="nl">${label}</span></button>`;
  return `<nav class="side" aria-label="Office">
    <div class="side-sec"><div class="side-h">Day to day</div>${link("today", "cal", "Today", needs)}${link("patients", "users", "Patients")}${link("calls", "phone", "Calls", S.calls ? S.calls[1] + S.calls[2] + S.calls[3] : 0)}${link("pvn", "note", "PCSE notices", S.pvn ? S.pvn.breach + S.pvn.todo + S.pvn.cancels : 0)}${link("opticabase", "copy", "Copy to Opticabase", S.diaryTodo || 0)}${link("leads", "send", "Facebook leads", (S.leads || []).filter((l) => l.status === "new").length)}${link("team", "shield", "Team &amp; hours")}</div>
    <div class="side-sec"><div class="side-h">Planning</div>${link("routes", "pin", "Plan routes")}${link("mileage", "car", "Mileage")}${link("pilot", "bolt", "Pilot results")}${link("invoices", "note", "Invoices")}</div>
    <div class="side-sec"><div class="side-h">Practice</div>${link("import", "copy", "Import patients")}${link("settings", "gear", "Settings")}${link("coming-soon", "next", "Coming soon")}</div>
  </nav>`;
}
/* ---------- Diary changes to copy into Opticabase (until the two systems can sync) ---------- */
const CHANGE_UI = { booked: ["b-ok", "Booked"], moved: ["b-forest", "Moved"], cancelled: ["b-crit", "Cancelled"], "not-seen": ["b-warn", "Not seen"] };
const ukDate = (iso) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
function diaryCsv(rows) {
  const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const head = ["Changed", "Change", "Opticabase ID", "Patient", "Date of birth", "Postcode", "Visit date", "Visit time", "Clinician", "Visit type", "Was date", "Was time", "Was clinician", "Reason"];
  return [head, ...rows.map((r) => [r.at, CHANGE_UI[r.change][1], r.obId, r.patient, r.dob, r.pc, r.visitDate, r.visitTime, r.clinician, r.type, r.wasDate, r.wasTime, r.wasClinician, r.reason])].map((x) => x.map(q).join(",")).join("\r\n");
}
function opticabasePage() {
  const g = UI.pg || {}, d = g.data;
  const head = pageHead({ eyebrow: esc(S.settings.practice), title: "Copy to Opticabase",
    lead: "Every visit booked, moved, cancelled or not seen in Domi, listed so the office can make the same change in the Opticabase diary. Tick each one off once it's done. Opticabase and Domi can't talk to each other directly yet, so this keeps the two diaries the same.",
    actions: d && d.todo.length ? `<button class="btn secondary" type="button" data-act="diary-csv">${icon("copy")}Download as a spreadsheet</button>` : "" });
  if (!d) return `<div class="pg">${head}<p class="muted">Loading…</p></div>`;
  const tab = g.tab || "todo", list = tab === "todo" ? d.todo : d.done;
  const tabs = `<div class="seg calls-tabs" role="tablist" aria-label="Which changes"><button type="button" role="tab" data-act="diary-tab" data-v="todo" aria-pressed="${tab === "todo"}">To copy<span class="mono">${d.todo.length}</span></button><button type="button" role="tab" data-act="diary-tab" data-v="done" aria-pressed="${tab === "done"}">Copied<span class="mono">${d.done.length}</span></button></div>`;
  const row = (r) => `<tr>
    <td><span class="badge ${CHANGE_UI[r.change][0]}">${CHANGE_UI[r.change][1]}</span><div class="muted" style="font-size:12px;margin-top:3px">${esc(r.at.slice(11))}${r.at.slice(0, 10) !== (calDay(0) || {}).iso ? ` · ${esc(ukDate(r.at.slice(0, 10)))}` : ""}</div></td>
    <td><b>${esc(r.patient || "")}</b><div class="muted mono" style="font-size:12px">${r.obId ? `Opticabase ${esc(r.obId)}` : `<span class="late">No Opticabase ID</span>`}${r.dob ? ` · ${esc(r.dob.split("-").reverse().join("/"))}` : ""}</div></td>
    <td><b>${esc(ukDate(r.visitDate))} ${esc(r.visitTime)}</b><div class="muted">${esc(r.clinician)} · ${esc(r.type)}</div>${r.change === "moved" ? `<div class="muted" style="font-size:12px">Was ${esc(ukDate(r.wasDate))} ${esc(r.wasTime)}${r.wasClinician !== r.clinician ? ` with ${esc(r.wasClinician)}` : ""}</div>` : ""}</td>
    <td class="muted" style="font-size:13px">${esc(r.reason || "")}</td>
    <td>${tab === "todo" ? `<button class="btn secondary sm" type="button" data-act="diary-copied" data-id="${r.id}">${icon("check")}Copied</button>` : `<span class="muted" style="font-size:12.5px">${esc(r.copiedBy || "")}, ${esc(r.copiedAt.slice(11))}</span>`}</td></tr>`;
  return `<div class="pg">${head}${tabs}
    ${list.length ? `<section class="card"><div class="pvn-tw"><table class="pvn-t dl-t"><thead><tr><th>Change</th><th>Patient</th><th>Visit</th><th>Why</th><th></th></tr></thead><tbody>${list.map(row).join("")}</tbody></table></div>
      ${tab === "todo" && list.length > 1 ? `<div class="form-f" style="padding:12px 0 0"><button class="btn" type="button" data-act="diary-copied-all">${icon("check")}All ${list.length} copied</button></div>` : ""}</section>`
      : `<div class="empty"><b>${tab === "todo" ? "Opticabase is up to date" : "Nothing copied yet"}</b>${tab === "todo" ? "New bookings, moves and cancellations appear here as they happen." : "Changes you tick off appear here."}</div>`}
  </div>`;
}

/* ---------- The pilot: baseline, targets, and what's measured each week ---------- */
/** One target as a chart: the baseline ("Before Domi") as a grey bar, then each pilot week, with the target dashed. */
function pilotChart(t, weeks, fmt) {
  const W = 300, H = 132, top = 18, bottom = 22, left = 4, right = 4, gap = 4;
  const vals = weeks.map((w) => w[t.key]);
  const max = Math.max(t.baseline || 0, t.goal || 0, ...vals.filter((v) => v != null)) * 1.15 || 1;
  const n = 1 + 13; // Before, then all 13 pilot weeks: the chart fills in as the pilot runs
  const bw = Math.min(26, (W - left - right - gap * (n - 1)) / n), base = H - bottom;
  const y = (v) => base - (v / max) * (base - top);
  const x = (i) => left + i * (bw + gap) + (i ? 6 : 0); // a little air between Before and week 1
  // Bars anchored to the baseline with a rounded data-end (4px) and a square foot.
  const bar = (i, v, cls, tip) => {
    if (v == null) return `<rect class="pc-none" x="${x(i)}" y="${base - 2}" width="${bw}" height="2" data-tip="${esc(tip)}: not measured yet"></rect>`;
    const h = Math.max(base - y(v), 2), r = Math.min(4, bw / 2, h);
    const X = x(i), Y = base - h;
    return `<path class="${cls}" d="M${X},${base}V${Y + r}Q${X},${Y} ${X + r},${Y}H${X + bw - r}Q${X + bw},${Y} ${X + bw},${Y + r}V${base}Z" data-tip="${esc(tip)}: ${esc(fmt(v, t.key))}${t.unit === "%" ? "" : " " + esc(t.unit)}"></path>`;
  };
  const marks = [bar(0, t.baseline, "pc-before", "Before Domi"),
    ...weeks.map((w, i) => bar(i + 1, w[t.key], w.inProgress ? "pc-after pc-now" : "pc-after", `Week ${w.week}${w.inProgress ? " so far" : ""}`))].join("");
  const last = [...weeks].reverse().find((w) => w[t.key] != null);
  const li = last ? weeks.indexOf(last) + 1 : null;
  const label = (i, v) => `<text class="pc-val" x="${x(i) + bw / 2}" y="${y(v) - 5}" text-anchor="middle">${esc(fmt(v, t.key))}</text>`;
  const goal = t.goal != null ? `<line class="pc-goal" x1="${left}" x2="${W - right}" y1="${y(t.goal)}" y2="${y(t.goal)}"></line>` : "";
  const xl = (i, s) => `<text class="pc-x" x="${x(i) + bw / 2}" y="${H - 6}" text-anchor="middle">${s}</text>`;
  return `<figure class="pl-chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t.label)}: before Domi ${esc(fmt(t.baseline, t.key))}, target ${esc(fmt(t.goal, t.key))}${last ? `, week ${last.week} ${esc(fmt(last[t.key], t.key))}` : ""}">
      <line class="pc-axis" x1="${left}" x2="${W - right}" y1="${base}" y2="${base}"></line>
      ${goal}${marks}${label(0, t.baseline)}${last ? label(li, last[t.key]) : ""}
      ${xl(0, "Before")}${li >= 3 ? xl(li, "Wk " + last.week) : ""}
    </svg>
    <figcaption class="pc-key"><span><i class="pc-sw before"></i>Before Domi</span><span><i class="pc-sw after"></i>With Domi, each week</span>${weeks.some((w) => w.inProgress) ? `<span><i class="pc-sw cur"></i>This week so far</span>` : ""}<span><i class="pc-sw goal"></i>Target</span></figcaption>
  </figure>`;
}
function pilotPage() {
  const g = UI.pg || {}, d = g.data;
  const head = pageHead({ eyebrow: esc(S.settings.practice), title: "Pilot results",
    lead: "What you measured before Domi, the targets agreed at signing, and what's happened each week since go-live, from your own diary. Visits, cancelled slots refilled and calls per refill are worked out by Domi. Miles and office hours are what you record each week: miles from the clinicians' mileage claims, the same source as your baseline, so the comparison is fair.",
    actions: d && d.config.start && !g.edit ? `<button class="btn secondary" type="button" data-act="pilot-edit">${icon("gear")}Change baseline or targets</button>` : "" });
  if (!d) return `<div class="pg">${head}<p class="muted">Loading…</p></div>`;
  const M = d.measures, c = d.config, fmt = (v, k) => v == null ? "–" : `${Number(v).toFixed(M[k].dp)}${M[k].unit === "%" ? "%" : ""}`;
  if (g.edit) {
    const tgt = (k) => (c.targets.find((t) => t.key === k) || {}).pct || "";
    return `<div class="pg narrow">${head}
      <form id="pilot-form" class="pg-form" novalidate data-keep-form>
        <section class="card"><div class="card-h"><h2>Go-live</h2><p>Week 1 starts on this day. The pilot runs 13 weeks.</p></div>
          <div class="row2"><div class="field"><label for="pl-start">Go-live date</label><input class="input" type="date" id="pl-start" value="${esc(c.start || "")}"></div>
          <div class="field"><label for="pl-by">Agreed with</label><input class="input" id="pl-by" maxlength="80" value="${esc(c.agreedBy || "")}" placeholder="Name and role"></div></div></section>
        <section class="card"><div class="card-h"><h2>Baseline and targets</h2><p>The baseline is your own figure from the 4 weeks before go-live. Tick up to four targets and how much better each must be. They decide whether the success fee is due at day 90.</p></div>
          <table class="pl-set"><thead><tr><th>Measure</th><th>Baseline</th><th>Target</th></tr></thead><tbody>
          ${Object.entries(M).map(([k, m]) => `<tr><td><b>${esc(m.label)}</b><div class="muted">${m.measured ? "Measured by Domi" : m.entry === "miles" ? "From the week's mileage claims, entered by the office" : "Recorded by the office each week"} · ${m.better === "down" ? "lower is better" : "higher is better"}</div></td>
            <td><input class="input sm" id="pl-b-${k}" inputmode="decimal" value="${esc(c.baseline[k] != null ? c.baseline[k] : "")}" aria-label="Baseline: ${esc(m.label)}"> <span class="muted">${esc(m.unit)}</span></td>
            <td><label class="chk"><input type="checkbox" id="pl-t-${k}" ${tgt(k) ? "checked" : ""}><span>${m.level ? "reach" : m.better === "down" ? "down by" : "up by"}</span></label> <input class="input sm" id="pl-p-${k}" inputmode="decimal" style="width:64px" value="${esc(tgt(k))}" aria-label="Target %: ${esc(m.label)}"> %</td></tr>`).join("")}
          </tbody></table></section>
        <div id="pl-err" aria-live="polite"></div>
        <div class="form-f">${c.start ? `<button class="btn ghost" type="button" data-act="pilot-cancel">Cancel</button>` : ""}<button class="btn" type="submit">${icon("check")}Save</button></div>
      </form></div>`;
  }
  const verdict = { "no-targets": ["plain", "No targets set yet"], measuring: ["apricot", `Measuring: ${d.weeksComplete} of 13 weeks complete`], met: ["ok", "On track: every target met"], "not-met": ["crit", "Not met yet"] }[d.status];
  const cards = d.targets.map((t) => `<div class="pl-card ${t.met === true ? "ok" : t.met === false ? "no" : ""}">
      <div class="caps">${esc(t.label)}</div>
      ${pilotChart(t, d.weeks, fmt)}
      <div class="pl-nums"><span><small>Before</small><b>${fmt(t.baseline, t.key)}</b></span><span class="arrow">→</span><span><small>Now${t.weeks ? ` (${t.weeks} wk avg)` : ""}</small><b>${fmt(t.now, t.key)}</b></span><span><small>Target</small><b>${fmt(t.goal, t.key)}</b></span></div>
      <div class="pl-foot">${t.met == null ? `<span class="muted">Measured once a full week is done</span>` : `<span class="badge ${t.met ? "b-ok" : "b-crit"}">${t.met ? "Met" : "Not met"}</span>`}${t.change != null ? `<span class="muted">${t.change > 0 ? "+" : ""}${t.change}${t.unit === "%" ? " points" : "%"} vs before · target ${t.level ? `${t.pct}%` : `${t.better === "down" ? "−" : "+"}${t.pct}%`}</span>` : ""}</div></div>`).join("");
  const row = (w) => `<tr class="${w.inProgress ? "pl-now" : ""}"><td><b>Week ${w.week}</b><div class="muted">${esc(w.label)}${w.inProgress ? " · so far" : ""}</div></td>
    <td class="mono">${w.visits}</td>
    <td><input class="input sm mono pl-entry" data-week="${w.week}" data-k="miles" inputmode="decimal" value="${w.milesClaimed != null ? esc(w.milesClaimed) : ""}" placeholder="–" aria-label="Miles claimed, week ${w.week}"></td>
    <td class="mono">${fmt(w.milesPerVisit, "milesPerVisit")}</td>
    <td class="mono">${w.cancellations}</td><td class="mono">${w.refilled}</td><td class="mono">${w.refillRate != null ? w.refillRate + "%" : "–"}</td><td class="mono">${w.unfilledPerWeek}</td><td class="mono">${fmt(w.callsPerRefill, "callsPerRefill")}</td>
    <td><input class="input sm mono pl-entry" data-week="${w.week}" data-k="hours" inputmode="decimal" value="${w.officeHours != null ? esc(w.officeHours) : ""}" placeholder="–" aria-label="Office hours, week ${w.week}"></td></tr>`;
  return `<div class="pg">${head}
    <div class="pl-top"><span class="badge b-${verdict[0]}">${esc(verdict[1])}</span><span class="muted">Go-live ${esc(new Date(c.start).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }))}${c.agreedBy ? ` · agreed with ${esc(c.agreedBy)}` : ""} · success fee reviewed after week 13</span></div>
    ${cards ? `<div class="pl-cards">${cards}</div>` : `<div class="callout">${icon("bolt")}<div>No targets yet. <button class="linkish" type="button" data-act="pilot-edit">Add the baseline and targets</button></div></div>`}
    <section class="card" style="margin-top:18px"><div class="card-h"><h2>Week by week</h2><p>Type each week's total from the mileage claims, and the office's hours; they save as you go. Miles per visit is the claimed miles over the visits done. Refill rate is the share of cancellations someone else was booked into; a week with no cancellations has none. Calls per refill counts every call logged on the call list (no answer, not interested, booked), so log each one there.</p></div>
      ${d.weeks.length ? `<div class="pvn-tw"><table class="pvn-t pl-t"><thead><tr><th>Week</th><th>Visits</th><th>Miles claimed</th><th>Miles / visit</th><th>Cancelled</th><th>Refilled</th><th>Refill rate</th><th>Left empty</th><th>Calls / refill</th><th>Office hours</th></tr></thead><tbody>${d.weeks.map(row).join("")}</tbody></table></div>`
        : `<div class="empty"><b>The pilot hasn't started</b>Week 1 begins on the go-live date.</div>`}
    </section></div>`;
}

/* ---------- PCSE pre-visit notifications (GOS6 PVNs): an office job, not on the clinician's phone ---------- */
const PVN_TABS = [["breach", "Breach risk"], ["todo", "To lodge"], ["early", "Too early to lodge"], ["notified", "Notified"], ["cancels", "Cancellations"]];
const ERT_ORDER = ["1", "2", "3.1", "3.2", "3.3", "4.1", "4.2", "5.1", "5.2", "5.3", "6"];
const pvnId = (key) => String(key).replace(/[^a-z0-9]/gi, "");
/** The same fields, in the same order, as PCSE Online's form: pasted into a note or read across field by field. */
function pvnText(v) {
  const f = v.form;
  return [`Date of visit: ${f.dateOfVisit}`, `Approximate time: ${f.approxTime}`, `Postcode: ${f.postcode}`, `Address: ${f.address}`, `Premises type: ${f.premisesType}`, `Contact name: ${f.contactName || "(missing)"}`, f.icbApproval ? `ICB prior approval: ${f.icbApproval}` : null,
    ...f.patients.map((p, i) => `\nPatient ${i + 1}\nFirst name: ${p.firstName}\nSurname: ${p.surname}\nDate of birth: ${p.dob || "(missing)"}\nNHS number: ${p.nhsNumber ? nhsSpaced(p.nhsNumber) : "(missing)"}\nLast sight test: ${p.lastSightTest || p.firstTest}${p.ertCode ? `\nEarly retest code: ${p.ertCode} (${p.ertText})` : ""}`)].filter((x) => x != null).join("\n");
}
function pvnPage() {
  const g = UI.pg || {}, d = g.data;
  const head = pageHead({ eyebrow: esc(S.settings.practice), title: "PCSE notifications",
    lead: "Every NHS sight test at home needs a pre-visit notification in PCSE Online before it happens: 48 hours ahead for 1 or 2 patients at an address (not counting weekends or bank holidays), 3 weeks ahead for 3 or more at one address, and never more than 8 weeks ahead. Copy each field across, then record the reference PCSE gives you. The GOS6 claim needs it." });
  if (!d) return `<div class="pg">${head}<p class="muted">Loading…</p></div>`;
  const n = { ...d.counts }, tab = g.tab || PVN_TABS.map(([k]) => k).find((k) => n[k]) || "todo";
  const tabs = `<div class="seg calls-tabs" role="tablist" aria-label="Which notifications">${PVN_TABS.map(([k, l]) => `<button type="button" role="tab" data-act="pvn-tab" data-v="${k}" aria-pressed="${k === tab}" ${k === "breach" && n.breach ? 'class="hot"' : ""}>${l}<span class="mono">${n[k]}</span></button>`).join("")}</div>`;
  const copy = (label, v) => v ? `<button class="btn ghost xs pvn-cp" type="button" data-act="pvn-copy" data-v="${esc(v)}" aria-label="Copy ${esc(label)}">${icon("copy")}</button>` : "";
  const field = (label, v, warn) => `<div class="pvn-f"><dt>${label}</dt><dd>${v ? `<span>${esc(v)}</span>${copy(label, v)}` : `<span class="late">${warn || "Missing"}</span>`}</dd></div>`;
  const card = (v) => {
    const f = v.form, id = pvnId(v.key), canLodge = v.status !== "early" && v.status !== "notified";
    const badge = v.status === "breach" ? `<span class="badge b-danger">Inside the notice period</span>` : v.status === "todo" ? `<span class="badge b-apricot">Lodge by ${esc(v.lodgeBy)}</span>` : v.status === "early" ? `<span class="badge b-plain">Lodge from ${esc(v.lodgeFrom)}</span>` : `<span class="badge b-ok">Notified${v.refs.length ? `: ${esc(v.refs.join(", "))}` : ""}</span>`;
    const pts = f.patients.map((p) => `<tr>
        <td>${esc(p.time)}</td><td><a href="#/patients/${esc(p.patientId)}">${esc(p.firstName)}</a> ${copy("first name", p.firstName)}</td><td>${esc(p.surname)} ${copy("surname", p.surname)}</td>
        <td class="mono">${p.dob ? `${esc(p.dob)} ${copy("date of birth", p.dob)}` : `<span class="late">Missing</span>`}</td>
        <td class="mono">${p.nhsNumber ? `${esc(nhsSpaced(p.nhsNumber))} ${copy("NHS number", p.nhsNumber)}` : `<a class="late" href="#/patients/${esc(p.patientId)}">Add it</a>`}</td>
        <td>${p.lastSightTest ? `<span class="mono">${esc(p.lastSightTest)}</span> ${copy("last sight test", p.lastSightTest)}` : `<span class="muted">${esc(p.firstTest)}</span>`}</td>
        <td>${v.status === "notified" ? (p.ertCode ? `<span class="mono">${esc(p.ertCode)}</span>` : `<span class="muted">None</span>`)
          : `<select class="input sm" data-act-change="pvn-ert" data-id="${esc(p.apptId)}" aria-label="Early retest code for ${esc(p.firstName)} ${esc(p.surname)}"><option value="">None (not early)</option>${ERT_ORDER.map((c) => `<option value="${c}" ${p.ertCode === c ? "selected" : ""}>${c}: ${esc(d.ert[c])}</option>`).join("")}</select>`}
          ${p.missing.includes("early retest code") ? `<div class="late" style="font-size:12px">Booked as an early retest: choose the reason</div>` : ""}</td></tr>`).join("");
    return `<article class="pvn-card ${v.status}" aria-label="${esc(f.dateOfVisit)}, ${esc(f.address)}">
      <header class="pvn-h"><div><b>${esc(v.dayLabel)} · from ${esc(f.approxTime)}</b><span class="muted">${esc(f.address)}, ${esc(f.postcode)}</span></div>
        <div class="pvn-badges"><span class="badge b-plain">${esc(f.premisesType)}</span><span class="badge b-forest" title="${esc(v.ruleText)}">${v.size} patient${v.size === 1 ? "" : "s"} · ${esc(v.rule)}' notice</span>${badge}</div></header>
      ${v.why ? `<div class="callout danger-card" role="alert">${icon("shield")}<div>${esc(v.why)}</div></div>` : ""}
      ${v.partly ? `<div class="callout apricot">${icon("clock")}<div>Some patients on this visit are notified and some aren't: add the rest to the same notification with Amend PVN in PCSE Online.</div></div>` : ""}
      ${v.status === "notified" ? `<details class="pvn-more"><summary>What was sent to PCSE</summary>` : ""}<dl class="pvn-grid">${field("Date of visit", f.dateOfVisit)}${field("Approximate time", f.approxTime)}${field("Postcode", f.postcode)}${field("Address", f.address)}${field("Premises type", f.premisesType)}${field("Contact name", f.contactName, "Missing: add who to ask for on the patient's record")}${f.icbApproval ? field("ICB prior approval", f.icbApproval) : ""}</dl>
      <div class="pvn-tw" data-scroll="pvn-${id}"><table class="pvn-t"><thead><tr><th>Time</th><th>First name</th><th>Surname</th><th>Date of birth</th><th>NHS number</th><th>Last sight test</th><th>Early retest code</th></tr></thead><tbody>${pts}</tbody></table></div>
      ${v.status === "notified" ? `</details>` : ""}
      ${f.note.length ? `<ul class="pvn-notes">${f.note.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${f.missing.length && v.status !== "notified" ? `<p class="late pvn-miss">${icon("x")} Before you lodge it: ${esc(f.missing.join("; "))}.</p>` : ""}
      <footer class="pvn-acts">
        <button class="btn secondary sm" type="button" data-act="pvn-copy" data-v="${esc(pvnText(v))}" data-all="1">${icon("copy")}Copy all the details</button>
        ${v.status === "notified" ? `<span class="muted">Lodged by ${esc([...new Set(v.lodged.map((m) => m.by).filter(Boolean))].join(", ") || "the office")}</span>` : ""}
        ${v.status === "breach" ? `<form class="pvn-icb" data-form="pvn-icb" data-ids="${esc(v.lodged.map((m) => m.id).join(","))}"><label for="icb-${id}" class="sr">Who at the ICB approved it</label><input class="input sm" id="icb-${id}" data-keep maxlength="80" placeholder="ICB approver's name" value="${esc(f.icbApproval || "")}"><button class="btn ghost sm" type="submit">Save approval</button></form>` : ""}
        ${canLodge ? `<form class="pvn-lodge" data-form="pvn-lodge" data-ids="${esc(v.lodged.filter((m) => !m.done).map((m) => m.id).join(","))}"><label for="ref-${id}" class="sr">PVN reference from PCSE Online</label><input class="input sm mono" id="ref-${id}" data-keep maxlength="24" placeholder="PVN reference" required><button class="btn sm" type="submit" ${v.status === "breach" && !f.icbApproval ? 'disabled title="Inside the notice period: record the ICB approval first, or move the visit"' : ""}>${icon("check")}Mark lodged</button></form>`
          : v.status === "early" ? `<span class="muted">PCSE won't take it more than 8 weeks ahead. It moves to To lodge on ${esc(v.lodgeFrom.replace(/ \d\d:\d\d$/, ""))}.</span>` : ""}
      </footer></article>`;
  };
  const visits = d.visits.filter((v) => v.status === tab);
  const what = { breach: "NHS sight tests inside their notice period with no notification lodged. Without the ICB's prior approval they can't go ahead as NHS visits: get the approval and lodge now, or move them.", todo: "Inside the 8-week window and still in time. Oldest deadline first.", early: "Booked more than 8 weeks ahead. PCSE rejects notifications that early, so these wait here.", notified: "Lodged, with PCSE's reference for the GOS6 claim.", cancels: "Visits cancelled after their notification was lodged: cancel each one in PCSE Online." }[tab];
  const body = tab === "cancels"
    ? (d.cancels.length ? `<ul class="calls">${d.cancels.map((c) => `<li class="call-row pvn-cx"><div><b>${esc(c.name)}</b><span class="muted">NHS sight test, ${esc(c.dayLabel)} ${esc(c.time)}</span></div><div>${c.ref ? `<span>PVN reference <span class="mono">${esc(c.ref)}</span> ${copy("PVN reference", c.ref)}</span>` : `<span class="muted">No reference recorded</span>`}</div><div class="cr-acts"><button class="btn secondary sm" type="button" data-act="pvn-cancel-done" data-id="${c.id}">${icon("check")}Cancelled in PCSE</button></div></li>`).join("")}</ul>`
      : `<div class="empty"><b>Nothing to cancel</b>Cancelling a notified NHS sight test adds it here.</div>`)
    : (visits.length ? visits.map(card).join("") : `<div class="empty"><b>${tab === "breach" ? "No visit is at risk" : "Nothing here"}</b>${tab === "breach" ? "Every NHS sight test inside its notice period has been notified." : "NHS sight tests appear here as they're booked."}</div>`);
  return `<div class="pg">${head}
    <div class="callout pvn-how">${icon("shield")}<div>Domi refuses an NHS sight test that can't meet its notice period, unless you record who at the ICB approved it. ${soon("pcse-online", "Send to PCSE automatically", "send")}</div></div>
    ${tabs}<p class="muted calls-what">${esc(what)}</p>${body}</div>`;
}
/* ---------- Confirmation calls (CC1-CC3) ---------- */
function callsPage() {
  const g = UI.pg || {}, d = g.data;
  const head = pageHead({ eyebrow: esc(S.settings.practice), title: "Confirmation calls",
    lead: "Every visit gets three calls, so the patient is in when the clinician knocks. Ring, then tick it off. No answer keeps it on the list for later. Text instead sends the same words as a text, for patients who'd rather have it in writing." });
  if (!d) return `<div class="pg">${head}<p class="muted">Loading…</p></div>`;
  const order = [3, 2, 1], stage = g.stage || order.find((k) => d.calls[k].length) || 3;
  const tabs = `<div class="seg calls-tabs" role="tablist" aria-label="Which calls">${order.map((k) => `<button type="button" role="tab" data-act="calls-stage" data-v="${k}" aria-pressed="${k === stage}"><b>${d.stages[k].code}</b>&nbsp;${esc(d.stages[k].title)}<span class="mono">${d.calls[k].length}</span></button>`).join("")}</div>`;
  const row = (x) => {
    const tel = String(x.patient.phone || "").replace(/[^\d+]/g, "");
    return `<li class="call-row">
      <div class="cr-who"><a class="nm" href="#/patients/${esc(x.patient.id)}">${esc(x.patient.name)}</a>${x.patient.obId ? `<span class="muted mono" style="font-size:12px">Opticabase ${esc(x.patient.obId)}</span>` : ""}
        ${x.patient.phone ? `<a class="mono cr-tel" href="tel:${esc(tel)}">${icon("phone")}${esc(x.patient.phone)}</a>` : `<span class="muted">No phone number</span>`}
        ${x.patient.rep ? `<span class="muted cr-rep">Family: ${esc(x.patient.rep)}</span>` : ""}
        ${x.patient.contact === "Call" ? `<span class="badge b-plain">Phone only</span>` : ""}</div>
      <div class="cr-visit"><span><span class="dot" style="background:${x.clinician.color}"></span>${esc(x.dayLabel)} · ${hm(x.start)} · ${esc(x.clinician.first)}</span>
        <span class="muted">${esc(T(x.type).name)}</span>
        ${x.window ? `<span class="badge b-forest">Window ${hm(x.window[0])}–${hm(x.window[1])}</span>` : ""}
        ${x.count != null && x.count < 1 ? `<span class="badge b-apricot" title="True count: may not be in">True count ${fmtCount(x.count)}</span>` : ""}</div>
      <div class="cr-say"><span class="caps">Tell them</span><q>${esc(x.say)}</q>
        ${x.tries ? `<span class="late">No answer ×${x.tries}${x.last ? ` · ${esc(x.last.by)}, ${esc(x.last.at)}` : ""}</span>` : ""}</div>
      <div class="cr-acts">
        <button class="btn sm" type="button" data-act="call-rec" data-id="${esc(x.apptId)}" data-s="${x.stage}" data-v="done">${icon("check")}Spoken to</button>
        <button class="btn secondary sm" type="button" data-act="call-rec" data-id="${esc(x.apptId)}" data-s="${x.stage}" data-v="no-answer">No answer</button>
        <button class="btn ghost sm" type="button" data-act="call-rec" data-id="${esc(x.apptId)}" data-s="${x.stage}" data-v="texted" ${x.canText ? `title="${esc(x.text)}"` : `disabled title="Asked to be phoned, not texted"`}>${icon("msg")}Text instead</button></div>
    </li>`;
  };
  const list = d.calls[stage];
  return `<div class="pg">${head}
    ${tabs}
    <p class="muted calls-what">${esc(d.stages[stage].code)}: ${esc(d.stages[stage].what)}.${stage === 2 ? " The window comes from the clinician's planned route, so plan routes first for the best times." : stage === 3 ? " A visit called here doesn't also get the automatic reminder text." : ""}</p>
    ${list.length ? `<ul class="calls">${list.map(row).join("")}</ul>` : `<div class="empty"><b>No ${esc(d.stages[stage].code)} calls to make</b>${stage === 3 ? "Everyone visited on the next working day has been called." : stage === 2 ? "Everyone visited in the next week has their window." : "Every new booking has been told its date."}</div>`}
  </div>`;
}
/** The page heading every office page shares: where you are, what it's for, and its main actions. */
const nhsSpaced = (n) => String(n).replace(/^(\d{3})(\d{3})(\d{4})$/, "$1 $2 $3");
const pageHead = ({ eyebrow, title, lead, actions = "", crumbs = "" }) => `<header class="pg-h">${crumbs}
  <div class="pg-ht"><div><div class="caps">${eyebrow}</div><h1 tabindex="-1">${title}</h1>${lead ? `<p>${lead}</p>` : ""}</div>${actions ? `<div class="pg-acts">${actions}</div>` : ""}</div></header>`;
const crumbsOf = (items) => `<nav class="pg-crumbs" aria-label="Breadcrumb"><ol>${items.map(([href, label], i) => `<li>${i === items.length - 1 ? `<span aria-current="page">${esc(label)}</span>` : `<a href="${href}">${esc(label)}</a>`}</li>`).join("")}</ol></nav>`;
const townOf = (pc) => { const d = String(pc || "").split(" ")[0].toUpperCase(); const a = (S.areas || []).find((x) => x.districts.includes(d)); return a ? a.town : ""; };
const nextVisit = (pid) => S.appts.filter((a) => a.patientId === pid && OPEN.includes(a.status)).sort((a, b) => (a.day || 0) - (b.day || 0) || a.start - b.start)[0];
const whenShort = (a) => `${a.day ? esc(dayName(a.day).slice(0, 3)) : "Today"} ${hm(a.start)}`;

/* ---------- Patients ---------- */
const PAGE = 25; // patients shown at a time; a practice moving from Opticabase may bring thousands
function patientsPage() {
  const all = S.patients.filter((p) => !p.erased);
  const waiting = new Set(S.waitlist.filter((w) => w.status !== "booked").map((w) => w.patientId));
  const recall = new Set((S.recalls || []).filter((r) => r.status !== "dismissed" && r.status !== "booked").map((r) => r.patientId));
  const F = { all: () => true, booked: (p) => !!nextVisit(p.id), waiting: (p) => waiting.has(p.id), recall: (p) => recall.has(p.id), phone: (p) => p.contact === "Call" };
  const f = F[UI.pf] ? UI.pf : "all";
  const words = String(UI.pq || "").toLowerCase().split(/\s+/).filter(Boolean);
  const list = all.filter(F[f]).filter((p) => words.every((w) => searchText(p).includes(w))).sort((a, b) => a.name.localeCompare(b.name));
  const tile = (k, n, label) => `<button type="button" class="stat ${f === k ? "on" : ""}" data-act="pf" data-v="${k}" aria-pressed="${f === k}"><b>${n}</b><span>${label}</span></button>`;
  return `<div class="pg">${pageHead({ eyebrow: esc(S.settings.practice), title: "Patients",
      lead: "Everyone you visit, with their next visit, how to reach them and whether they're waiting. Open anyone for their full record.",
      actions: `<button class="btn secondary" type="button" data-act="import">${icon("copy")}Import patients</button><button class="btn secondary" type="button" data-act="book">${icon("cal")}Book a visit</button><a class="btn" href="#/patients/new">${icon("plus")}Add a patient</a>` })}
    <div class="stats">${tile("all", all.length, "patients")}${tile("booked", all.filter(F.booked).length, "booked this week")}${tile("waiting", all.filter(F.waiting).length, "on the waiting list")}${tile("recall", all.filter(F.recall).length, "due a recall")}${tile("phone", all.filter(F.phone).length, "phone, don't text")}</div>
    <section class="card tbl-card" aria-label="Patient list">
      <div class="tbl-tools"><div class="search-w">${icon("search")}<input class="input" id="pg-q" data-keep type="search" placeholder="Search by name, postcode, phone, date of birth or Opticabase ID" autocomplete="off" value="${esc(UI.pq || "")}" aria-label="Search patients"></div>
        <span class="muted tbl-count">${list.length === all.length ? `${all.length} patients` : `${list.length} of ${all.length}`}</span></div>
      ${list.length ? `<div class="tbl-wrap"><table class="ptable"><thead><tr><th scope="col">Patient</th><th scope="col">Area</th><th scope="col">Contact</th><th scope="col">Next visit</th><th scope="col"><span class="sr">Status</span></th></tr></thead><tbody>
        ${list.slice(0, UI.plimit || PAGE).map((p) => { const a = nextVisit(p.id); return `<tr data-act="go" data-v="patients/${esc(p.id)}">
          <td><a class="pn" href="#/patients/${esc(p.id)}"><span class="avatar sm soft">${initials(p.name)}</span><span><b>${esc(p.name)}</b><span class="muted">${p.age ? `Age ${p.age} · ` : ""}${esc(p.addr)}</span></span></a></td>
          <td><b class="mono">${esc(p.pc)}</b><span class="muted">${esc(townOf(p.pc))}</span></td>
          <td><span class="mono">${esc(p.phone || "–")}</span><span class="muted">${p.contact === "Call" ? "Phone, don't text" : "Texts"}</span></td>
          <td>${a ? `<b>${whenShort(a)}</b><span class="muted">${esc(T(a.type).name)}</span>` : `<span class="muted">Nothing booked</span>`}</td>
          <td class="st">${waiting.has(p.id) ? `<span class="badge b-apricot">Waiting</span>` : ""}${recall.has(p.id) ? `<span class="badge b-forest">Recall</span>` : ""}${p.alerts.length ? `<span class="badge b-plain" title="${esc(p.alerts.join(". "))}">Notes</span>` : ""}</td></tr>`; }).join("")}
        </tbody></table></div>${list.length > (UI.plimit || PAGE) ? `<div class="tbl-more"><span class="muted">Showing ${UI.plimit || PAGE} of ${list.length}</span><button class="btn secondary" type="button" data-act="pmore">Show ${Math.min(PAGE, list.length - (UI.plimit || PAGE))} more</button></div>` : ""}`
      : `<div class="empty"><b>Nobody matches</b>Try a surname, a postcode like BL1, or the last digits of a phone number.</div>`}
    </section></div>`;
}
function patientPage() {
  const g = UI.pg || {}, p = g.rec;
  const crumbs = crumbsOf([["#/patients", "Patients"], ["", p && !p.missing ? p.name : "Patient"]]);
  if (!p) return `<div class="pg">${pageHead({ crumbs, eyebrow: "Patient record", title: "Opening…" })}</div>`;
  if (p.missing) return `<div class="pg">${pageHead({ crumbs, eyebrow: "Patient record", title: "Not found", lead: "This record doesn't exist any more. It may have been erased, or the demo restarted." })}<a class="btn secondary" href="#/patients">${icon("back")}All patients</a></div>`;
  if (p.erased) return `<div class="pg">${pageHead({ crumbs, eyebrow: "Patient record", title: "Erased patient", lead: "This patient's personal details were erased on request. The anonymous visit history is kept so the diaries and reports still add up." })}</div>`;
  const visits = S.appts.filter((a) => a.patientId === p.id && OPEN.includes(a.status)).sort((a, b) => a.day - b.day || a.start - b.start);
  const waits = S.waitlist.filter((w) => w.patientId === p.id && w.status !== "booked");
  const rec = (S.recalls || []).find((r) => r.patientId === p.id && r.status !== "dismissed");
  const tabs = [["overview", "Overview"], ["visits", `Visits${visits.length ? ` <span class="tc">${visits.length}</span>` : ""}`], ["history", "Notes &amp; history"], ["data", "Their data"]];
  const tab = tabs.some(([k]) => k === g.tab) ? g.tab : "overview";
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const hero = `<section class="pt-hero">
      <span class="avatar xl" aria-hidden="true">${initials(p.name)}</span>
      <div class="pt-id"><h1 tabindex="-1">${esc(p.name)}</h1>
        <p>${p.age ? `${p.age} years · ` : ""}${esc(p.addr)}, ${esc(p.pc)}</p>
        <div class="tags">${p.contact === "Call" ? `<span class="badge b-plain">${icon("phone")}Phone, don't text</span>` : `<span class="badge b-plain">${icon("msg")}Texts</span>`}${waits.length ? `<span class="badge b-apricot">On the waiting list</span>` : ""}${rec ? `<span class="badge b-forest">Recall due</span>` : ""}${p.alerts.map((a) => `<span class="badge b-warn">${esc(a)}</span>`).join("")}</div></div>
      <div class="pg-acts">${p.phone ? `<a class="btn secondary" href="tel:${esc(p.phone.replace(/\s/g, ""))}">${icon("phone")}Call</a>` : ""}<button class="btn secondary" type="button" data-act="rec-edit">${icon("note")}Edit details</button><button class="btn" type="button" data-act="book-for" data-id="${p.id}">${icon("plus")}Book a visit</button></div>
    </section>`;
  const nav = `<nav class="pg-tabs" aria-label="Sections of the record">${tabs.map(([k, l]) => `<a href="#/patients/${esc(p.id)}/${k}" ${k === tab ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>`;
  let body = "";
  if (g.edit) body = `<section class="card"><div class="card-h"><h2>Edit details</h2><p>Changes reach the clinician's phone straight away. A new address re-works that round's drive times.</p></div>${patientFormFields(p)}</section>`;
  else if (tab === "overview") {
    const a = visits[0];
    body = `<div class="cards2">
      <section class="card"><div class="card-h"><h2>Contact</h2></div><dl class="kv lg">${row("Phone", `<span class="mono">${esc(p.phone || "None")}</span>`)}${row("How to reach them", p.contact === "Call" ? "Phone, don't text" : "Text messages")}${p.email ? row("Email", esc(p.email)) : ""}${row("Next of kin or carer", esc(p.rep || "None recorded"))}${row("Power of attorney", esc(p.poa || "None recorded"))}${row("May we talk to family?", p.share === "yes" ? "Yes" : p.share === "no" ? `<span class="late">No: only the patient</span>` : "Not asked yet")}</dl></section>
      <section class="card"><div class="card-h"><h2>Home visit</h2></div><dl class="kv lg">${row("Why at home", p.eligibility ? esc(p.eligibility) : `<span class="late">Not recorded. The NHS claim needs it.</span>`)}${p.dob || !p.age ? row("Date of birth", esc(dobText(p))) : row("Age", `${p.age}, date of birth not recorded`)}${row("Glasses", esc(p.specs || "Not recorded"))}${p.obId ? row("Opticabase ID", `<span class="mono">${esc(p.obId)}</span>`) : ""}${row("NHS number", p.nhsNo ? `<span class="mono">${esc(nhsSpaced(p.nhsNo))}</span>` : `<span class="late">Not recorded. PCSE's notification and the GOS6 claim need it.</span>`)}${row("Seen at", esc(p.premises && p.premises !== "home" ? `${PREMISES_UI[p.premises]}${p.venue ? `: ${p.venue}` : ""}${p.venueContact ? ` (ask for ${p.venueContact})` : ""}` : "Their own home"))}${p.nextExam ? row("Next exam (Opticabase)", esc(new Date(p.nextExam).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }))) : ""}${row("Last sight test", p.lastTest ? `${esc(new Date(p.lastTest).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }))} · ${p.recallMonths || 12}-month recall` : `<span class="muted">Not recorded</span>`)}${p.nhsFrom ? row("Next NHS sight test", p.nhsFrom.day > 0 ? `Not before <b>${esc(p.nhsFrom.label)}</b>` : `Due now <span class="muted">(from ${esc(p.nhsFrom.label)})</span>`) : ""}${row("Notes for the clinician", p.alerts.length ? esc(p.alerts.join(". ")) : "None")}</dl></section>
      <section class="card"><div class="card-h"><h2>Next visit</h2></div>${a ? `<div class="nv"><b>${a.day ? esc(dayName(a.day)) : "Today"} at ${hm(a.start)}</b><span>${esc(T(a.type).name)} with ${esc((cln(a.clinicianId) || {}).name || "")}</span></div><a class="linkish" href="#/patients/${esc(p.id)}/visits">All visits and actions</a>` : `<p class="muted">Nothing booked.</p><button class="btn secondary sm" type="button" data-act="book-for" data-id="${p.id}">${icon("plus")}Book a visit</button>`}</section>
      <section class="card"><div class="card-h"><h2>Waiting list${rec ? " and recall" : ""}</h2></div>${waits.length || rec ? `<ul class="mini">${waits.map((w) => `<li><b>${T(w.type).name}</b> · ${esc(META.prio[w.prio].label)} priority${w.note ? `<div>${esc(w.note)}</div>` : ""}</li>`).join("")}${rec ? `<li><b>Recall</b> · ${esc(rec.reason)}</li>` : ""}</ul><p class="muted" style="font-size:13px;margin:10px 0 0">Offered any cancelled visit nearby that fits.</p>` : `<p class="muted">Not waiting for anything.</p>`}</section>
    </div>`;
  } else if (tab === "visits") {
    body = `<section class="card"><div class="card-h"><h2>Booked visits</h2><p>Move a visit, cancel it, or copy the private link a relative can use to cancel.</p></div>
      ${visits.length ? `<ul class="vlist">${visits.map((a) => { const c = cln(a.clinicianId); return `<li><span class="vd"><b>${a.day ? esc(dayName(a.day)) : "Today"}</b><span class="mono">${hm(a.start)}</span></span>
        <span class="vw"><b>${esc(T(a.type).name)}</b><span class="muted">with ${esc(c ? c.name : "")}${a.status !== "booked" ? ` · ${a.status === "live" ? "with the patient now" : "on the way"}` : ""}</span></span>
        ${a.status === "booked" ? `<span class="acts"><button class="btn ghost sm" type="button" data-act="cancel-link" data-id="${a.id}">${icon("copy")}Family link</button><button class="btn secondary sm" type="button" data-act="open-appt" data-id="${a.id}">Cancel</button><button class="btn sm" type="button" data-act="move" data-id="${a.id}">${icon("cal")}Move</button></span>` : ""}</li>`; }).join("")}</ul>`
      : `<div class="empty"><b>No visits booked</b><button class="btn sm" type="button" data-act="book-for" data-id="${p.id}" style="margin-top:10px">${icon("plus")}Book a visit</button></div>`}</section>`;
  } else if (tab === "history") {
    body = `<section class="card"><div class="card-h"><h2>Add a note</h2><p>Kept on the record and visible to the clinician.</p></div>
        <form id="pg-note" class="note-f"><textarea class="input" id="pg-note-t" data-keep rows="3" maxlength="1000" placeholder="e.g. Daughter rang: mornings are best from now on." required></textarea><button class="btn" type="submit">${icon("check")}Add note</button></form></section>
      <section class="card"><div class="card-h"><h2>History</h2></div>${p.history && p.history.length ? `<ol class="timeline">${p.history.map((n) => `<li><div class="tl-h"><b>${esc(n.label)}</b><span class="muted">${esc(n.by || "")}${n.at ? ` · ${esc(n.at)}` : ""}</span></div><div>${esc(n.body)}</div></li>`).join("")}</ol>` : `<p class="muted">Nothing yet.</p>`}</section>`;
  } else {
    body = `<div class="cards2"><section class="card"><div class="card-h"><h2>Download everything</h2><p>If ${esc(first(p.name))}, or someone acting for them, asks what you hold (a subject access request), download it all and send it securely.</p></div>
        <button class="btn secondary" type="button" data-act="rec-export">${icon("copy")}Download their records</button></section>
      <section class="card danger-card"><div class="card-h"><h2>Erase their details</h2><p>Removes their details for good. Not possible while a visit is booked, or for anyone already seen: clinical and NHS claim records must be kept for at least 7 years.</p></div>
        <div class="field"><label for="erase-name">Type ${esc(p.name)} to confirm</label><input class="input" id="erase-name" data-keep autocomplete="off"></div>
        <button class="btn danger" type="button" data-act="rec-erase">Erase their details</button></section></div>`;
  }
  return `<div class="pg">${crumbs}${hero}${g.edit ? "" : nav}${body}</div>`;
}
/** The edit form's fields, shared by the record page and the side panel. */

/* ---------- Planning and practice tools as pages: the same contents as their side panels, laid out full width ---------- */
const TOOL_LEADS = {
  plans: "Domi puts each clinician's visits in the order that drives least, from their home base and back. Nothing changes until you apply it, and patients whose time moves are told by text.",
  report: "How far each clinician drove and how full their days were, from the diary. Download it for mileage claims.",
  invoices: "Raised automatically when a visit is completed, at your prices in Settings. Mark them paid, void them, or print one.",
  import: "Bring patients across from Opticabase or any spreadsheet. Every row is checked, duplicates are caught, and nothing is saved until you say so.",
};
function toolPage(kind) {
  const P = UI.pg || {};
  const html = kind === "plans" ? plansDrawer(P) : kind === "report" ? (P.data ? reportDrawer(P.data) : "") : kind === "invoices" ? (P.data ? invoicesDrawer(P.data) : "") : importDrawer();
  if (!html) return `<div class="pg"><p class="muted">Loading…</p></div>`;
  const box = document.createElement("div"); box.innerHTML = html;
  const h = box.querySelector(".drawer-h"), b = box.querySelector(".drawer-b"), f = box.querySelector(".drawer-f");
  const caps = h && h.querySelector(".caps") ? h.querySelector(".caps").innerHTML : "", title = h && h.querySelector("h2") ? h.querySelector("h2").innerHTML : "";
  if (b) { const intro = b.firstElementChild; if (intro && intro.tagName === "P" && intro.classList.contains("muted")) intro.remove(); } // the page lead says it
  return `<div class="pg tool-pg tool-${kind}">${pageHead({ eyebrow: caps, title, lead: TOOL_LEADS[kind] })}
    <section class="card tool-card">${b ? b.innerHTML : ""}</section>${f && f.innerHTML.trim() ? `<div class="form-f sticky">${f.innerHTML}</div>` : ""}</div>`;
}

/* ---------- Facebook leads: the people who asked for a call from the practice's ads ---------- */
const LEAD_TABS = [["new", "To call"], ["contacted", "Called"], ["booked", "Visit booked"], ["closed", "Not interested"], ["all", "All"]];
function leadsPage() {
  const all = S.leads || [], tab = LEAD_TABS.some(([k]) => k === UI.lt) ? UI.lt : "new";
  const list = all.filter((l) => tab === "all" || l.status === tab);
  const fresh = all.filter((l) => l.status === "new"), oldest = fresh.reduce((m, l) => Math.min(m, l.atMin), Infinity);
  const link = { ...((S.settings || {}).leadLink || {}), on: !!(S.settings || {}).metaConnected };
  const tile = (k, n, label) => `<button type="button" class="stat ${tab === k ? "on" : ""}" data-act="lt" data-v="${k}" aria-pressed="${tab === k}"><b>${n}</b><span>${label}</span></button>`;
  return `<div class="pg">${pageHead({ eyebrow: "From your Facebook ads", title: "Facebook leads",
      lead: "People who filled in the form on your ad and asked to be called. Each one has already been emailed a thank-you with your office hours.",
      actions: `<button class="btn secondary" type="button" data-act="adform">${icon("send")}Send a test lead</button><a class="btn" href="#/settings/facebook">${icon("gear")}Connect Facebook</a>` })}
    <div class="stats">${tile("new", fresh.length, fresh.length ? `to call · oldest ${leadWait({ atMin: oldest })}` : "to call")}${tile("contacted", all.filter((l) => l.status === "contacted").length, "called")}${tile("booked", all.filter((l) => l.status === "booked").length, "visit booked")}${tile("closed", all.filter((l) => l.status === "closed").length, "not interested")}${tile("all", all.length, "all leads")}</div>
    <div class="conn-strip ${link.error ? "bad" : link.lastAt || link.on ? "ok" : ""}">${icon(link.error ? "x" : link.lastAt || link.on ? "check" : "bolt")}<span>${link.error ? `<b>Problem with the connection.</b> ${esc(link.error)}` : link.lastAt ? `<b>Connected.</b> Last lead at ${esc(link.lastAt)}, through ${esc(link.lastVia)}.` : link.on ? `<b>Connected to Facebook.</b> Waiting for the first lead from your ads.` : `<b>Not connected yet.</b> Leads from your ads will arrive here once your Facebook is connected.`}</span><a href="#/settings/facebook">${link.lastAt && !link.error ? "Connection settings" : "Connect"}</a></div>
    <section class="card tbl-card" aria-label="Leads">
      ${list.length ? `<div class="tbl-wrap"><table class="ptable"><thead><tr><th scope="col">Lead</th><th scope="col">Phone</th><th scope="col">From the ad</th><th scope="col">Arrived</th><th scope="col"><span class="sr">Status</span></th></tr></thead><tbody>
        ${list.map((l) => `<tr data-act="go" data-v="leads/${esc(l.id)}">
          <td><a class="pn" href="#/leads/${esc(l.id)}"><span class="avatar sm soft">${initials(l.name)}</span><span><b>${esc(l.name)}</b><span class="muted">${esc([l.pc, townOf(l.pc)].filter(Boolean).join(" · ") || l.email || "")}</span></span></a></td>
          <td><span class="mono">${esc(l.phone || "–")}</span><span class="muted">${l.email ? "Has email" : "No email"}</span></td>
          <td><b>${esc(l.campaign || "Ad form")}</b><span class="muted">${esc((l.answers[0] || [])[1] || "")}</span></td>
          <td><b>${esc(l.at)}</b><span class="muted">${l.status === "new" ? `Waiting ${leadWait(l)}` : esc(l.handledBy ? `By ${l.handledBy}` : "")}</span></td>
          <td class="st"><span class="badge ${l.status === "new" ? "b-apricot" : l.status === "booked" ? "b-forest" : "b-plain"}">${esc(S.leadStatus[l.status])}</span>${l.patientId ? `<span class="badge b-plain">Patient</span>` : ""}</td></tr>`).join("")}
        </tbody></table></div>`
      : `<div class="empty"><b>${tab === "new" ? "Nobody waiting for a call" : "None here"}</b>${tab === "new" ? "New leads from your ads appear here straight away." : "Leads move here as the office marks them."}</div>`}
    </section></div>`;
}
function leadPage() {
  const l = (S.leads || []).find((x) => x.id === UI.route.id);
  const crumbs = crumbsOf([["#/leads", "Facebook leads"], ["", l ? l.name : "Lead"]]);
  if (!l) return `<div class="pg">${pageHead({ crumbs, eyebrow: "Facebook lead", title: "Lead not found" })}<p class="muted">It may have been removed. <a href="#/leads">Back to leads</a></p></div>`;
  const mail = (S.leadEmails || []).find((m) => m.leadId === l.id);
  const p = l.patientId && S.patients.find((x) => x.id === l.patientId);
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const tel = l.phone ? l.phone.replace(/\s/g, "") : "";
  return `<div class="pg">${crumbs}
    <section class="pt-hero"><span class="avatar xl">${initials(l.name)}</span>
      <div class="pt-id"><div class="caps">Facebook lead · ${esc(l.at)}</div><h1 tabindex="-1">${esc(l.name)}</h1><p>${esc(l.campaign || "From an ad form")}${l.pc ? ` · ${esc(l.pc)}` : ""}</p>
        <div class="tags"><span class="badge ${l.status === "new" ? "b-apricot" : l.status === "booked" ? "b-forest" : "b-plain"}">${esc(S.leadStatus[l.status])}</span>${l.status === "new" ? `<span class="badge b-plain">Waiting ${leadWait(l)}</span>` : ""}${p ? `<span class="badge b-plain">On Domi as a patient</span>` : ""}</div></div>
      <div class="pg-acts">${tel ? `<a class="btn secondary" href="tel:${esc(tel)}">${icon("phone")}Call ${esc(l.phone)}</a>` : ""}${p ? `<a class="btn" href="#/patients/${esc(p.id)}">${icon("users")}Open their record</a>` : `<button class="btn" type="button" data-act="lead-patient" data-id="${esc(l.id)}">${icon("plus")}Add as a patient</button>`}</div></section>
    ${l.status === "new" ? `<div class="callout apricot">${icon("clock")}<div><b>Call them soon</b><div style="margin-top:2px">People called within the hour are far more likely to book. Mark the lead below once you've spoken.</div></div></div>` : ""}
    <div class="cards2">
      <section class="card"><div class="card-h"><h2>What they told you</h2></div><dl class="kv lg">${row("Phone", l.phone ? `<span class="mono">${esc(l.phone)}</span>` : "None given")}${row("Email", esc(l.email || "None given"))}${(l.addr ? row("Street address", esc(l.addr)) : "")}${l.dob ? row("Date of birth", `${esc(new Date(l.dob).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }))} <span class="muted">· check it on the call</span>`) : ""}${row("Postcode", l.pc ? `${esc(l.pc)}${l.pcFrom === "address" ? ` <span class="muted">· found in their address</span>` : ""}` : `<span class="late">Not on the form: ask for it on the call</span>`)}${l.answers.map(([q, a]) => row(esc(q), esc(a))).join("")}</dl></section>
      <section class="card"><div class="card-h"><h2>After the call</h2><p>What happened, so everyone in the office knows.</p></div>
        <div class="field"><label for="ld-note">Note</label><textarea class="input" id="ld-note" data-keep rows="4" placeholder="e.g. Spoke to her daughter. Wants a morning visit next week.">${esc(l.note || "")}</textarea></div>
        ${l.handledBy ? `<p class="set-note" style="margin-top:6px">Last updated by ${esc(l.handledBy)} at ${esc(l.handledAt)}.</p>` : ""}
        <div class="lead-acts">${["contacted", "booked", "closed"].map((k) => `<button class="btn ${k === "booked" ? "" : k === "closed" ? "ghost" : "secondary"}" type="button" data-act="lead-status" data-id="${l.id}" data-v="${k}" aria-pressed="${l.status === k}">${k === "booked" ? icon("check") : k === "contacted" ? icon("phone") : ""}${k === "contacted" ? "Called" : esc(S.leadStatus[k])}</button>`).join("")}</div></section>
    </div>
    <section class="card"><div class="card-h"><h2>The thank-you email</h2><p>${mail ? `Sent automatically at ${esc(mail.at)} to ${esc(mail.to)}.` : "No email address was given, so no thank-you email went. Call them instead."}</p></div>
      ${mail ? `<div class="mailcard"><div class="mail-h"><b>${esc(mail.subject)}</b><span class="muted">From ${esc(S.settings.practice)}</span></div><div class="mail-b">${esc(mail.body)}</div></div>` : ""}</section>
  </div>`;
}

/** Settings → Facebook leads: the two ways to connect, and whether leads are arriving. */
function facebookSection() {
  const c = UI.pg && UI.pg.conn;
  if (!c) return `<p class="muted">Loading…</p>`;
  const st = c.status || {}, m = c.meta;
  const copyRow = (label, v, id) => `<div class="field"><label for="${id}">${label}</label><div class="copy-row"><input class="input mono" id="${id}" value="${esc(v)}" readonly><button class="btn secondary" type="button" data-act="copy" data-v="${esc(v)}">${icon("copy")}Copy</button></div></div>`;
  return `<div class="pg-form">
    <section class="card conn-card ${st.error ? "bad" : st.lastAt || m.connected ? "ok" : ""}"><div class="conn-h">${icon(st.error ? "x" : st.lastAt || m.connected ? "check" : "bolt")}<div>
      <h2>${st.error ? "There's a problem with the connection" : st.lastAt ? "Leads are arriving" : m.connected ? "Connected to Facebook" : "Not connected yet"}</h2>
      <p>${st.error ? `${esc(st.error)} <span class="muted">(${esc(st.errorAt)})</span>` : st.lastAt ? `${st.count} lead${st.count === 1 ? "" : "s"} received in this demo. The last one came at ${esc(st.lastAt)}, through ${esc(st.lastVia)}.` : m.connected ? "Waiting for the first lead from your ads. Facebook's Lead Ads Testing Tool can send one now." : "Pick one of the two ways below. Until then you can try it with the test ad form."}</p></div>
      <button class="btn secondary" type="button" data-act="adform">${icon("send")}Send a test lead</button></div></section>

    <section class="card"><div class="card-h"><span class="badge b-forest">Quickest · works today</span><h2 style="margin-top:8px">Connect through Zapier or Make</h2><p>Zapier or Make picks up each lead from your Facebook Lead Ads and passes it to Domi. No approval from Meta is needed, and it takes about ten minutes.</p></div>
      <ol class="steps">
        <li>In Zapier, make a Zap: <b>Facebook Lead Ads → New Lead</b>. Sign in with the Facebook account that runs your ads and pick your Page and form.</li>
        <li>Add the action <b>Webhooks by Zapier → POST</b>. Paste your private link below as the URL, choose <b>JSON</b>, and map the form's fields. Any field names work: full name, phone, email and postcode are picked up, and every other question is kept as asked.</li>
        <li>Turn the Zap on and send a test lead from Facebook's Lead Ads Testing Tool. It appears in Facebook leads straight away, and the thank-you email goes out.</li>
      </ol>
      ${copyRow("Your private link", c.hookUrl, "fb-hook")}
      <p class="set-note">This link includes your practice's secret key. Anyone with it can add leads, so keep it inside Zapier or Make. If it's ever shared by mistake, make a new one and the old link stops working at once.</p>
      <div style="margin-top:12px"><button class="btn ghost" type="button" data-act="fb-key">${icon("reset")}Make a new link</button></div>
      ${uses(["Facebook leads", "Thank-you emails", "Needs you today"])}</section>

    <form id="fb-meta" class="card" novalidate><div class="card-h"><span class="badge b-plain">Direct · needs Meta's approval</span><h2 style="margin-top:8px">Connect straight to Facebook</h2><p>Facebook tells Domi the moment a lead arrives, with no Zapier in between. It needs a Meta app with permission to read leads (leads_retrieval), which Meta approves after a review. We set this up with you once.</p></div>
      <div class="row2">${copyRow("Callback URL, for your Meta app's Webhooks", m.callbackUrl, "fb-cb")}${copyRow("Verify token", m.verifyToken, "fb-vt")}</div>
      <p class="set-note">In your Meta app, add the Webhooks product, choose <b>Page</b>, paste these two in, and subscribe to the <b>leadgen</b> field.</p>
      <div class="row2" style="margin-top:14px">${sf("pageId", "Facebook Page ID", m.pageId, 'inputmode="numeric" maxlength="30" placeholder="e.g. 104523987612345"', "From your Page's About section, under Page transparency.")}
        ${sf("appSecret", "App secret", "", `type="password" autocomplete="off" maxlength="64" placeholder="${m.hasSecret ? "Saved · leave blank to keep it" : "32 letters and numbers"}"`, "From your Meta app's Basic settings. Used to check each notice really came from Facebook.")}</div>
      ${sf("pageToken", "Page access token", "", `type="password" autocomplete="off" maxlength="600" placeholder="${m.hasToken ? `Saved, ending ${esc(m.tokenEnd)} · leave blank to keep it` : "A long-lived Page token"}"`, "Lets Domi fetch each lead's answers from Facebook. It's stored on the server and never shown again.")}
      <div class="form-f" style="justify-content:space-between">${m.connected ? `<button class="btn ghost" type="button" data-act="fb-disconnect">Disconnect</button>` : "<span></span>"}<button class="btn" type="submit">${icon("check")}${m.connected ? "Save changes" : "Connect"}</button></div>
      ${m.connected ? `<p class="set-note">Connected to Page ${esc(m.pageId)}. Facebook will send new leads here; any problem fetching one shows at the top of this page.</p>` : ""}
    </form>
  </div>`;
}

/* ---------- Settings: the practice's details and rules, which the rest of Domi reads ---------- */
const SET_SECS = [
  { k: "practice", icon: "shield", label: "Practice details", sub: "Name, contact details, logo" },
  { k: "hours", icon: "clock", label: "Opening hours", sub: "When the diary runs" },
  { k: "visits", icon: "cal", label: "Visits & prices", sub: "Prices and online booking" },
  { k: "refill", icon: "bolt", label: "Cancellations & reminders", sub: "How gaps are filled" },
  { k: "messages", icon: "msg", label: "What patients receive", sub: "Texts and emails" },
  { k: "booking", icon: "qr", label: "Booking & referral pages", sub: "Links for your website" },
  { k: "facebook", icon: "send", label: "Facebook leads", sub: "Connect your ad forms" },
];
const uses = (list) => `<div class="uses"><span class="caps">Used in</span>${list.map((x) => `<span class="use">${x}</span>`).join("")}</div>`;
const setFoot = (label = "Save changes") => `<div class="form-f sticky"><button class="btn" type="submit">${icon("check")}${label}</button></div>`;
const sf = (id, label, v, extra = "", hint = "") => `<div class="field"><label for="set-${id}">${label}</label><input class="input" id="set-${id}" value="${esc(v == null ? "" : v)}" ${hint ? `aria-describedby="set-${id}-h"` : ""} ${extra}>${hint ? `<span class="hint after" id="set-${id}-h">${hint}</span>` : ""}</div>`;
const timeOpts = (sel, from, to) => quarters(from, to).map((m) => `<option value="${m}" ${m === sel ? "selected" : ""}>${hm(m)}</option>`).join("");

/** A day from 07:00 to 20:00 with the practice's hours shaded and each clinician's working day on top. */
function hoursPreview(s, e) {
  const L = 7 * 60, R = 20 * 60, pc = (m) => ((m - L) / (R - L)) * 100;
  const clin = (UI.pg && UI.pg.team ? UI.pg.team.clinicians : []).filter((c) => c.active);
  const ticks = [8, 10, 12, 14, 16, 18].map((h) => `<span class="hp-t" style="left:${pc(h * 60)}%">${String(h).padStart(2, "0")}:00</span>`).join("");
  const row = (c) => { const h = (c.hours || []).filter(Boolean); if (!h.length) return ""; const a = Math.min(...h.map((x) => x[0])), b = Math.max(...h.map((x) => x[1])); const bad = a < s || b > e;
    const over = [a < s ? [a, s] : null, b > e ? [e, b] : null].filter(Boolean).map(([x, y]) => `<i class="bad" style="left:${pc(x)}%;right:${100 - pc(y)}%"></i>`).join("");
    return `<div class="hp-r"><span class="hp-n">${esc(c.first || c.name)}</span><span class="hp-track"><i style="left:${pc(a)}%;right:${100 - pc(b)}%;background:${c.color}"></i>${over}</span><span class="hp-v ${bad ? "late" : "muted"}">${hm(a)}–${hm(b)}${bad ? " · clash" : ""}</span></div>`; };
  return `<div class="hp" aria-hidden="true"><div class="hp-r hp-main"><span class="hp-n">Practice</span><span class="hp-track"><i style="left:${pc(s)}%;right:${100 - pc(e)}%"></i>${ticks}</span><span class="hp-v"><b>${hm(s)}–${hm(e)}</b></span></div>${clin.map(row).join("")}</div>`;
}

/** How many of the most common visit fit in a clinician's day at these lengths, with typical driving between. */
function dayFit(st) {
  const len = T("sight").dur, drive = 20, day = st.dayEnd - st.dayStart;
  const n = Math.floor((day + drive) / (len + drive));
  return `<div class="callout plain" style="margin:0 0 12px">${icon("clock")}<div>At ${len} minutes for an NHS sight test and about ${drive} minutes' driving between patients, a ${hm(st.dayStart)}–${hm(st.dayEnd)} day fits about <b>${n} sight tests</b>.</div></div>`;
}
/** How far ahead each kind of booking can go. */
function aheadCard(st) {
  const opt = (sel, list) => list.map(([v, l]) => `<option value="${v}" ${Number(sel) === v ? "selected" : ""}>${l}</option>`).join("");
  const weeks = (ns) => ns.map((n) => [n * 7, n + (n === 1 ? " week" : " weeks")]), months = (ns) => ns.map((n) => [n === 12 ? 365 : n === 24 ? 730 : Math.round(n * 30.4), n + " months"]);
  return `<section class="card"><div class="card-h"><h2>How far ahead</h2><p>Bank holidays in England and Wales, weekends and your closure days below are never offered.</p></div>
    <div class="field"><label for="set-ba">The office can book up to</label><select class="input" id="set-ba">${opt(st.bookAheadDays, weeks([4, 8]).concat(months([3, 6, 9, 12, 18, 24])))}</select><span class="hint after">For recalls and annual sight tests booked at the end of a visit.</span></div>
    <div class="field"><label for="set-oa">Patients can book online up to</label><select class="input" id="set-oa">${opt(st.onlineAheadDays, weeks([1, 2, 3, 4, 6, 8, 12]).concat(months([6])))}</select><span class="hint after">Kept shorter so online bookings fill the near diary first, and nobody books a slot you might close.</span></div>
    <div class="field"><label for="set-fa">Offer cancelled gaps to the waiting list up to</label><select class="input" id="set-fa">${opt(st.offerAheadDays, [[3, "3 days"], [7, "1 week"], [14, "2 weeks"], [21, "3 weeks"], [28, "4 weeks"], [42, "6 weeks"]])}</select><span class="hint after">A gap further out is left open for normal booking: there's time for it to fill without texting anyone.</span></div>
    ${uses(["Book a visit", "Moving a visit", "Online booking", "Refilling cancellations"])}</section>`;
}
/** The practice's own closure days, on top of bank holidays. */
function closuresCard(st) {
  UI.pg = UI.pg || {};
  if (!UI.pg.clo) UI.pg.clo = (st.closures || []).map((c) => ({ date: c.date, reason: c.reason || "" }));
  const today = (calDay(0) || {}).iso || "", list = UI.pg.clo.slice().sort((a, b) => a.date.localeCompare(b.date));
  const nice = (iso) => { const d = dayByIso(iso); return d != null ? dayLong(d) : iso; };
  return `<section class="card"><div class="card-h"><h2>Closure days</h2><p>Training days, staff holidays or anything else the practice is shut for. The diary greys them out and nothing can be booked on them.</p></div>
    ${list.length ? `<ul class="clo-list">${list.map((c) => `<li><span><b>${esc(nice(c.date))}</b>${c.reason ? ` · ${esc(c.reason)}` : ""}${c.date < today ? ` <span class="muted">(past)</span>` : ""}</span><button class="btn ghost sm" type="button" data-act="clo-del" data-v="${esc(c.date)}" aria-label="Remove ${esc(nice(c.date))}">${icon("x")}Remove</button></li>`).join("")}</ul>` : `<p class="muted" style="margin:0 0 12px">No closure days yet. Bank holidays are already closed.</p>`}
    <div class="row2" style="align-items:end"><div class="field" style="margin:0"><label for="clo-date">Date</label><input class="input" type="date" id="clo-date" min="${today}" max="${(calDay(S.cal.bookAheadDays) || {}).iso || ""}"></div>
      <div class="field" style="margin:0"><label for="clo-why">Reason</label><input class="input" id="clo-why" maxlength="60" placeholder="e.g. Staff training"></div></div>
    <button class="btn secondary sm" type="button" data-act="clo-add" style="margin-top:10px">${icon("plus")}Add closure day</button>
    <p class="set-note">Press Save changes to keep them. A day that already has visits booked can't be closed: move those visits first.</p></section>`;
}

function settingsPage() {
  const st = S.settings, sec = UI.route.sec || "practice", b = S.brand || {};
  const nav = `<nav class="set-nav" aria-label="Settings sections">${SET_SECS.map((x) => `<a href="#/settings/${x.k}" ${x.k === sec ? 'aria-current="page"' : ""}>${icon(x.icon)}<span><b>${x.label}</b><span>${x.sub}</span></span></a>`).join("")}</nav>`;
  let body = "";
  if (sec === "practice") {
    body = `<form id="set-practice" class="pg-form" novalidate>
      <section class="card"><div class="card-h"><h2>Your practice</h2><p>How patients, families and referrers see you.</p></div>
        ${sf("practice", "Practice name", st.practice, 'maxlength="60" required', "Texts are signed with this, and it heads every email, invoice and public page.")}
        <div class="row2">${sf("phone", "Phone number", st.phone, 'inputmode="tel" maxlength="24"', "Shown on the booking, referral and cancellation pages, and in emails.")}${sf("email", "Email", st.email, 'type="email" maxlength="120"', "Replies to lead emails come here, and it's on every invoice.")}</div>
        ${sf("hoursText", "Office hours", st.officeHours, 'maxlength="120"', "In words, as patients read it: the thank-you email to every ad lead quotes it.")}
        ${uses(["Texts", "Lead emails", "Invoices", "Booking page", "Referral form", "Cancellation page"])}</section>
      <section class="card"><div class="card-h"><h2>Logo</h2><p>Shown at the top of Domi for everyone in the practice.</p></div>
        <div class="logo-row"><div class="logo-prev" id="logo-prev">${st.logo ? `<img src="${esc(st.logo)}" alt="Current logo" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('broken')">` : ""}<span>${st.logo ? "This address doesn't load an image" : "No logo: your name is shown instead"}</span></div>
          <div class="logo-f">${sf("logo", "Logo address", st.logo, 'type="url" maxlength="300" placeholder="https://www.yourpractice.co.uk/logo.png"', "The web address of your logo, for example the one on your own website. Leave empty to show your name.")}</div></div>
        ${uses(["Top bar", "Booking page", "Referral form"])}</section>
      ${setFoot()}</form>`;
  } else if (sec === "hours") {
    const s = st.dayStart, e = st.dayEnd;
    body = `<form id="set-hours" class="pg-form" novalidate>
      <section class="card"><div class="card-h"><h2>When the practice's day runs</h2><p>The diary shows these hours, and every clinician's working hours must fit inside them.</p></div>
        <div class="row2"><div class="field"><label for="set-ds">Opens</label><select class="input" id="set-ds">${timeOpts(s, 7 * 60, 16 * 60)}</select></div>
          <div class="field"><label for="set-de">Closes</label><select class="input" id="set-de">${timeOpts(e, 11 * 60, 20 * 60)}</select></div></div>
        <div id="hp-wrap">${hoursPreview(s, e)}</div>
        <p class="set-note">Each clinician's own days and hours are set on <a href="#/team">Team &amp; hours</a>. If someone works outside new hours, Domi names them so you can change theirs first, and no booked visit is left outside the diary.</p>
        ${uses(["Diary", "Clinicians' hours", "Route planning", "Refilling cancellations", "Online booking"])}</section>
      ${aheadCard(st)}
      ${closuresCard(st)}
      ${setFoot()}</form>`;
  } else if (sec === "visits") {
    const types = Object.entries(TYPES_NOW() || {});
    body = `<form id="set-visits" class="pg-form" novalidate>
      <section class="card tbl-card"><div class="card-h" style="padding:20px 22px 0"><h2>Visits and prices</h2><p>The price is what the patient is invoiced when a visit is done. £0 means no invoice: NHS sight tests are claimed on a GOS form, and glasses are charged when ordered.</p></div>
        <div class="tbl-wrap"><table class="ptable vtable"><thead><tr><th scope="col">Visit</th><th scope="col">Length</th><th scope="col">Price</th><th scope="col">Patients can book online</th></tr></thead><tbody>
        ${types.map(([k, t]) => { const can = k !== "dispense"; const on = (st.online || []).includes(k); return `<tr><td><b>${esc(t.name)}</b>${t.optom ? `<span class="muted">Optometrists only${t.pvn ? " · PCSE notice 48 hours before" : ""}</span>` : `<span class="muted">Any clinician</span>`}</td>
          <td><select class="input len-in" data-dur="${k}" aria-label="Length of ${esc(t.name)}">${[10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 75, 90, 105, 120].concat(t.dur).filter((m, i, a) => a.indexOf(m) === i).sort((a, b) => a - b).map((m) => `<option value="${m}" ${m === t.dur ? "selected" : ""}>${m} min</option>`).join("")}</select></td>
          <td><label class="money-in"><span>£</span><input class="input" type="number" min="0" max="5000" step="1" data-price="${k}" value="${Number((st.prices || {})[k] || 0)}" aria-label="Price for ${esc(t.name)}"></label></td>
          <td>${can ? `<label class="chk"><input type="checkbox" data-online="${k}" ${on ? "checked" : ""}><span>${on ? "Yes" : "No"}</span></label>` : `<span class="muted">Arranged by the practice</span>`}</td></tr>`; }).join("")}
        </tbody></table></div>
        <div style="padding:0 22px 20px"><p class="set-note">The length is the time with the patient; Domi adds the driving between visits itself. It shapes every booking, refill offer, planned route and the diary. If a longer length would run a booked visit into the next one, Domi names it so it can be moved first.</p>${dayFit(st)}<div class="field" style="max-width:340px"><label for="set-tgt">Target: patients seen per clinician per day</label><select class="input" id="set-tgt">${Array.from({ length: 20 }, (_, i) => i + 1).map((n) => `<option ${n === (st.clinicTarget || 10) ? "selected" : ""}>${n}</option>`).join("")}</select><span class="hint after">Each clinic's true count is shown against this in the diary. Recalls count 1; old recalls, new patients, Facebook leads and referrals 0.5.</span></div>${uses(["Diary", "Booking", "Refilling cancellations", "Route planning", "Invoices", "Booking page"])}</div></section>
      ${setFoot()}</form>`;
  } else if (sec === "refill") {
    const mins = [5, 10, 15, 20, 30, 45, 60, 90, 120];
    body = `<form id="set-refill" class="pg-form" novalidate>
      <section class="card"><div class="card-h"><h2>When a visit is cancelled</h2><p>Domi picks the best-matched patients on the waiting list: urgency, area, how long they've waited and the extra driving.</p></div>
        <div class="choice2" role="radiogroup" aria-label="How cancelled visits are filled">
          <label class="choice"><input type="radio" name="set-mode" value="offer" ${st.mode === "offer" ? "checked" : ""}><span><b>${icon("send")}Text an offer</b><span>Patients reply YES to take it. The best match is asked first; when the visit is close, the top three are asked at once.</span></span></label>
          <label class="choice"><input type="radio" name="set-mode" value="phone" ${st.mode === "phone" ? "checked" : ""}><span><b>${icon("phone")}Phone a call list</b><span>Nobody is texted. The office gets the waiting list ranked for that slot, best match first, with each number to ring and one click to book.</span></span></label>
          <label class="choice"><input type="radio" name="set-mode" value="instant" ${st.mode === "instant" ? "checked" : ""}><span><b>${icon("bolt")}Book instantly</b><span>The best match is booked straight in and told by text. Fastest, but nobody is asked first.</span></span></label></div>
        <div class="row2" style="margin-top:14px"><div class="field"><label for="set-om">Normal reply window</label><select class="input" id="set-om">${mins.map((m) => `<option value="${m}" ${m === st.offerMinutes ? "selected" : ""}>${m} minutes</option>`).join("")}</select><span class="hint after">Shorter when the visit is close.</span></div>
          ${sf("fee", "Your fee per visit (£)", st.fee, 'type="number" min="0" max="2000" step="1"', "Used to show what refilled cancellations are worth.")}</div>
        ${uses(["Waiting list", "Offer texts", "Today's income figures"])}</section>
      <section class="card"><div class="card-h"><h2>Day-before reminders</h2><p>Each patient gets a text the day before, with a link a relative can use to cancel. A cancellation a day ahead can be refilled; one at the door can't.</p></div>
        <label class="chk big"><input type="checkbox" id="set-rem" ${st.reminders ? "checked" : ""}><span>Send reminders</span></label>
        <div class="field" style="max-width:320px;margin-top:12px"><label for="set-ra">Send them at</label><select class="input" id="set-ra">${quarters(8 * 60, 21 * 60).map((m) => `<option value="${m}" ${m === st.reminderAt ? "selected" : ""}>${hm(m)}</option>`).join("")}</select></div>
        ${uses(["Reminder texts", "Cancellation links"])}</section>
      <section class="card"><div class="card-h"><h2>Recall texts</h2><p>Patients due a sight test within a fortnight, or overdue, are texted your booking page once. They also stay in the refill pool, so a cancelled visit near them is offered first.</p></div>
        <label class="chk big"><input type="checkbox" id="set-arc" ${st.autoRecalls ? "checked" : ""}><span>Send recall texts automatically</span></label>
        <div class="field" style="max-width:320px;margin-top:12px"><label for="set-rat">Send them at</label><select class="input" id="set-rat">${quarters(8 * 60, 18 * 60).map((m) => `<option value="${m}" ${m === st.recallAt ? "selected" : ""}>${hm(m)}</option>`).join("")}</select></div>
        <p class="set-note">Patients who'd rather be phoned are never texted: they stay on the Recalls list for the office to call.</p>
        ${uses(["Recalls", "Booking page", "Waiting list"])}</section>
      ${setFoot()}</form>`;
  } else if (sec === "booking") {
    const card = (refer) => { const url = `${location.origin}/${refer ? "refer" : "book"}/${S.sandbox}`; let qr = ""; try { const q = qrcode(0, "M"); q.addData(url); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch (e) { qr = ""; }
      return `<section class="card link-card"><div class="link-qr">${qr}</div><div class="link-b"><div class="card-h"><h2>${refer ? "Referral form" : "Patient booking page"}</h2><p>${refer ? "For patients, family, carers, care homes and GPs. Link it from your website's Contact page. Referrals arrive on Today, under Referrals, with no emails or documents." : `Patients pick a time themselves. It only offers times from tomorrow that add 20 minutes of driving or less, and never shows anyone else's details. What can be booked is set in <a href="#/settings/visits">Visits &amp; prices</a>.`}</p></div>
        <div class="copy-row"><input class="input mono" value="${esc(url)}" readonly aria-label="${refer ? "Referral form" : "Booking page"} link"><button class="btn secondary" type="button" data-act="copy" data-v="${esc(url)}">${icon("copy")}Copy</button><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open</a></div>
        ${uses(refer ? ["Your website", "Referrals on Today"] : ["Your website", "Recall texts", "Leaflets (QR code)"])}</div></section>`; };
    body = `<div class="pg-form">${card(false)}${card(true)}</div>`;
  } else if (sec === "facebook") {
    body = facebookSection();
  } else {
    const m = UI.pg && UI.pg.msgs;
    const u = S.textUsage || { texts: 0, parts: 0, pence: 0, pencePerPart: 5 };
    body = !m ? `<p class="muted">Loading…</p>` : `<div class="pg-form">
      <section class="card usage"><div class="usage-n"><b>${u.texts}</b><span>texts sent to patients</span></div><div class="usage-n"><b>${u.parts}</b><span>billed text parts</span></div><div class="usage-n"><b>£${(u.pence / 100).toFixed(2)}</b><span>at ${u.pencePerPart}p a part</span></div>
        <p class="set-note" style="grid-column:1 / -1">A text is billed in 160-character parts, so most reminders and offers count as 2 parts. Texts to the clinicians' phones are free. In this demo the count covers everything sent since it started.</p></section>
      <section class="card"><div class="card-h"><h2>Texts</h2><p>Worded from your settings, exactly as patients get them. Change the practice name, hours or reminder time and these change too.</p></div>
        <div class="msgs">${m.messages.map((x) => `<article class="msg-p"><header><b>${esc(x.title)}</b><span class="muted">${esc(x.when)}</span></header><div class="bubble">${esc(x.body)}</div></article>`).join("")}</div></section>
      <section class="card"><div class="card-h"><h2>Email to every ad lead</h2><p>Sent the moment someone fills in the form on your Facebook ad. Replies go to ${esc(st.email || "your practice email")}.</p></div>
        <div class="mailcard"><div class="mail-h"><b>${esc(m.lead.subject)}</b><span class="muted">From ${esc(st.practice)}</span></div><div class="mail-b">${esc(m.lead.body)}</div></div></section>
      <p class="set-note">The wording itself is set by Domi for now, so every message stays clear and within the rules for texting patients. Ask us if you'd like a line changed.</p></div>`;
  }
  return `<div class="pg">${pageHead({ eyebrow: esc(st.practice), title: "Settings", lead: "Your practice's details and rules. Everything here feeds the diary, texts, emails, invoices and the booking page." })}
    <div class="set-wrap">${nav}<div class="set-body">${body}</div></div></div>`;
}

/** Adding a patient by hand: someone who phoned, or a referral that came by post. Grouped as the office asks for it. */
function newPatientPage() {
  const pre = (UI.pg && UI.pg.pre) || {};
  const f = (id, label, extra = "", hint = "") => `<div class="field"><label for="np-${id}">${label}</label><input class="input" id="np-${id}" value="${esc(pre[id] || "")}" ${hint ? `aria-describedby="np-${id}-h"` : ""} ${extra}>${hint ? `<span class="hint after" id="np-${id}-h">${hint}</span>` : ""}</div>`;
  return `<div class="pg narrow">${pageHead({ crumbs: crumbsOf([["#/patients", "Patients"], ["", "Add a patient"]]), eyebrow: "New patient", title: "Add a patient",
      lead: pre.leadId ? `From their Facebook lead: what they gave is filled in.${pre.pc ? "" : " Their form didn't ask for a postcode, so add it from the call."} Check the date of birth with them, and add anything else you learned.` : "For someone who phoned in or was referred on paper. Name, address and a phone number are enough to book them; the rest can follow." })}
    <form id="np-form" class="pg-form" novalidate>
      <section class="card"><div class="card-h"><h2>Who they are</h2></div>
        <div class="row2">${f("name", "Full name", 'maxlength="80" required autocomplete="off"')}${f("dob", "Date of birth", 'type="date" min="1900-01-01" max="2026-10-12"', "Checked against everyone already on Domi.")}</div></section>
      <section class="card"><div class="card-h"><h2>Where to visit</h2><p>Drive times, the clinician who covers the area and route planning all come from this.</p></div>
        ${f("addr", "First line of the address", 'maxlength="120" required placeholder="e.g. 14 Moor Lane, or Flat 2, Rose Court"')}
        <div class="field">${DomiAreas.picker(S.areas || [], "np-pc", pre.pc || "")}</div></section>
      <section class="card"><div class="card-h"><h2>How to reach them</h2><p>Reminders and cancellation offers go by text unless they'd rather be phoned.</p></div>
        <div class="row2">${f("phone", "Phone", 'inputmode="tel" required placeholder="07700 900123"')}
          <div class="field"><label for="np-contact">How to reach them</label><select class="input" id="np-contact"><option value="Text">Text (needs a mobile)</option><option value="Call">Phone, don't text</option></select></div></div>
        <div class="row2">${f("email", "Email", 'type="email" maxlength="120"', "Optional.")}${f("rep", "Next of kin or carer, and their number", 'maxlength="120"', "Optional.")}</div>
        <div class="row2">${f("poa", "Power of attorney (health and welfare)", 'maxlength="120"', "Who holds it, and their number. Optional.")}<div class="field"><label for="np-share">May we talk to their next of kin or carer about visits?</label><select class="input" id="np-share"><option value="" ${!pre.share ? "selected" : ""}>Not asked yet</option><option value="yes" ${pre.share === "yes" ? "selected" : ""}>Yes</option><option value="no" ${pre.share === "no" ? "selected" : ""}>No: only the patient</option></select></div></div></section>
      <section class="card"><div class="card-h"><h2>Their visit</h2><p>What the clinician needs to know before they knock.</p></div>
        ${f("elig", "Why they need a home visit", 'maxlength="200" placeholder="e.g. Dementia, or Parkinson\'s"', "The condition itself. The NHS claim needs it, so “housebound” alone isn't enough.")}
        ${f("specs", "Glasses", 'maxlength="80" placeholder="e.g. Varifocals"')}
        ${nhsFields("np", pre)}
        <div class="field"><label for="np-alerts">Notes for the clinician, one per line</label><textarea class="input" id="np-alerts" rows="3" maxlength="1000" placeholder="Key safe by the back door"></textarea></div></section>
      <div id="np-err" aria-live="polite"></div>
      <div class="form-f sticky"><a class="btn ghost" href="#/patients">Cancel</a><button class="btn" type="submit">${icon("check")}Add patient</button></div>
    </form></div>`;
}
/** Where they're seen and their NHS number: PCSE's notification groups patients at one care home or day centre into one visit. */
const PREMISES_UI = { home: "Their own home", residential: "Residential home", nursing: "Nursing home", day: "Day centre", sheltered: "Sheltered housing (each flat is its own address)" };
const nhsFields = (px, p) => `<div class="row2"><div class="field"><label for="${px}-nhs">NHS number</label><input class="input mono" id="${px}-nhs" value="${esc(p.nhsNo || "")}" inputmode="numeric" maxlength="12" placeholder="10 digits"></div>
    <div class="field"><label for="${px}-prem">Where they're seen</label><select class="input" id="${px}-prem">${Object.entries(PREMISES_UI).map(([k, l]) => `<option value="${k}" ${(p.premises || "home") === k ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>
    <div class="row2"><div class="field"><label for="${px}-venue">Care home or day centre name</label><input class="input" id="${px}-venue" value="${esc(p.venue || "")}" maxlength="80" placeholder="Leave empty for their own home"></div><div class="field"><label for="${px}-vc">Who to ask for there</label><input class="input" id="${px}-vc" value="${esc(p.venueContact || "")}" maxlength="80" placeholder="e.g. the duty manager"></div></div>`;
function patientFormFields(p) {
  const f = (id, label, v, extra = "") => `<div class="field"><label for="pe-${id}">${label}</label><input class="input" id="pe-${id}" value="${esc(v || "")}" ${extra}></div>`;
  return `<form id="pe-form" class="pg-form">
    <div class="row2">${f("name", "Full name", p.name, 'maxlength="80" required')}${f("dob", "Date of birth", p.dob, 'type="date" min="1900-01-01" max="2026-10-12"')}</div>
    ${f("addr", "First line of the address", p.addr, 'maxlength="120" required')}
    <div class="field">${DomiAreas.picker(S.areas || [], "pe-pc", p.pc)}</div>
    <div class="row2">${f("phone", "Phone", p.phone, 'inputmode="tel" required')}
      <div class="field"><label for="pe-contact">How to reach them</label><select class="input" id="pe-contact"><option value="Text" ${p.contact === "Text" ? "selected" : ""}>Text (needs a mobile)</option><option value="Call" ${p.contact === "Call" ? "selected" : ""}>Phone, don't text</option></select></div></div>
    ${f("email", "Email", p.email, 'type="email" maxlength="120"')}
    ${f("elig", "Why they need a home visit", p.eligibility, 'maxlength="200" placeholder="The condition, e.g. Dementia, not just housebound"')}
    <div class="row2">${f("rep", "Next of kin or carer, and their number", p.rep, 'maxlength="120"')}${f("specs", "Glasses", p.specs, 'maxlength="80"')}</div>
<div class="row2">${f("ob", "Opticabase ID", p.obId, 'maxlength="20" inputmode="numeric" placeholder="e.g. 25220"')}${f("next", "Next exam (from Opticabase)", p.nextExam, 'type="date"')}</div>
    ${nhsFields("pe", p)}
    <div class="row2">${f("last", "Last sight test", p.lastTest, `type="date" min="1990-01-01" max="${(calDay(0) || {}).iso || ""}"`)}<div class="field"><label for="pe-recall">Recall (set by the optometrist)</label><select class="input" id="pe-recall">${[[12, "12 months"], [6, "6 months"], [3, "3 months"], [24, "24 months"]].map(([m, l]) => `<option value="${m}" ${(p.recallMonths || 12) === m ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>
    <div class="row2">${f("poa", "Power of attorney (health and welfare), and their number", p.poa, 'maxlength="120" placeholder="Leave empty if nobody holds one"')}<div class="field"><label for="pe-share">May we talk to their next of kin or carer about visits?</label><select class="input" id="pe-share"><option value="" ${!p.share ? "selected" : ""}>Not asked yet</option><option value="yes" ${p.share === "yes" ? "selected" : ""}>Yes</option><option value="no" ${p.share === "no" ? "selected" : ""}>No: only the patient</option></select></div></div>
    <div class="field"><label for="pe-alerts">Notes for the clinician, one per line</label><textarea class="input" id="pe-alerts" rows="3" maxlength="1000" placeholder="Key safe by the back door">${esc(p.alerts.join("\n"))}</textarea></div>
    <div class="form-f"><button class="btn ghost" type="button" data-act="rec-edit-cancel">Cancel</button><button class="btn" type="submit">${icon("check")}Save changes</button></div>
  </form>`;
}

/* ---------- Team & hours ---------- */
const weekBar = (h) => `<span class="wkbar" aria-label="${esc(hoursText(h))}">${WD().map((d, i) => { const x = h[i]; const span = dayE() - dayS(); return `<span class="wd" title="${esc(d.slice(0, 3))}: ${x ? `${hm(x[0])}–${hm(x[1])}` : "day off"}"><i style="${x ? `left:${((x[0] - dayS()) / span) * 100}%;right:${100 - ((x[1] - dayS()) / span) * 100}%` : "display:none"}"></i><em>${esc(d.slice(0, 1))}</em></span>`; }).join("")}</span>`;
function teamPage() {
  const g = UI.pg || {}, t = g.data;
  if (g.edit) return personPage(t, g.edit);
  if (!t) return `<div class="pg">${pageHead({ eyebrow: esc(S.settings.practice), title: "Team &amp; hours" })}<p class="muted">Loading…</p></div>`;
  const clin = t.clinicians.filter((c) => c.active), off = t.clinicians.filter((c) => !c.active);
  const card = (c) => `<a class="pcard ${c.active ? "" : "off"}" href="#/team/clin/${esc(c.id)}">
      <span class="pc-top"><span class="avatar" style="background:${c.color}">${initials(c.name)}</span><span><b>${esc(c.name)}</b><span class="muted">${esc(c.role)}${c.office ? " · office access" : ""}</span></span>${c.active ? signinBadge(c.signin) : `<span class="badge b-plain">Switched off</span>`}</span>
      <span class="pc-area">${icon("pin")}${esc(c.areaName || "No area set")}</span>
      <span class="chips-r">${c.patch.slice(0, 8).map((d) => `<span class="chip">${esc(d)}</span>`).join("")}${c.patch.length > 8 ? `<span class="chip">+${c.patch.length - 8}</span>` : ""}</span>
      <span class="pc-hours">${weekBar(c.hours)}<span class="muted">${esc(hoursText(c.hours))}</span></span></a>`;
  return `<div class="pg">${pageHead({ eyebrow: esc(S.settings.practice), title: "Team &amp; hours",
      lead: "Who visits where, and when. Booking, refills and route planning only use these areas and hours, so keep them up to date.",
      actions: `<button class="btn secondary" type="button" data-act="tm-edit" data-k="staff">${icon("plus")}Add office account</button><button class="btn" type="button" data-act="tm-edit" data-k="clin">${icon("plus")}Add a clinician</button>` })}
    <section class="pg-sec"><div class="sec-h"><h2>Clinicians</h2><span class="muted">${clin.length} on the road</span></div><div class="pcards">${clin.map(card).join("")}</div>
      ${off.length ? `<details class="off-list"><summary>${off.length} switched off</summary><div class="pcards">${off.map(card).join("")}</div></details>` : ""}</section>
    <section class="pg-sec"><div class="sec-h"><h2>Office</h2><span class="muted">See every diary and patient</span></div>
      <div class="card"><ul class="staff">${t.staff.map((u) => `<li class="${u.active ? "" : "off"}"><span class="avatar sm" style="background:${u.color || "#5B6770"}">${initials(u.name)}</span><span class="who"><b>${esc(u.name)}</b><span class="muted">${esc(u.title || "Office")} · ${esc(u.email)}</span></span>${u.active ? signinBadge(u.signin) : `<span class="badge b-plain">Switched off</span>`}<a class="btn secondary sm" href="#/team/staff/${esc(u.id)}">Open</a></li>`).join("")}</ul></div></section>
    <div class="callout plain">${icon("shield")}<div>Everyone signs in with their own password and a code from an authenticator app. New people get an emailed link to set both up, and nobody else ever knows them. Lost phone or forgotten password? Open their page and reset their sign-in. Switching someone off signs them out on every device at once; their history stays.</div></div>
  </div>`;
}
function personPage(t, edit) {
  const crumbs = crumbsOf([["#/team", "Team & hours"], ["", "…"]]);
  if (!t) return `<div class="pg">${pageHead({ crumbs, eyebrow: "Team", title: "Loading…" })}</div>`;
  const isClin = edit.kind === "clin";
  if (!isClin) {
    const u = t.staff.find((x) => x.id === edit.id) || { name: "", title: "", email: "", active: true };
    return `<div class="pg narrow">${pageHead({ crumbs: crumbsOf([["#/team", "Team & hours"], ["", u.name || "New office account"]]), eyebrow: edit.id ? "Office account" : "New office account", title: esc(u.name || "Add an office account"), lead: "Office accounts see every patient and every round, so give one only to people who run the diary." })}
      <form id="tm-staff" data-id="${esc(edit.id || "")}" class="pg-form">
        <section class="card"><div class="card-h"><h2>Details</h2></div>
          <div class="row2"><div class="field"><label for="ts-name">Full name</label><input class="input" id="ts-name" value="${esc(u.name)}" maxlength="60" required></div><div class="field"><label for="ts-title">Job title</label><input class="input" id="ts-title" value="${esc(u.title || "")}" maxlength="60" placeholder="Receptionist"></div></div>
          <div class="field"><label for="ts-email">Signs in with (email)</label><input class="input" id="ts-email" type="email" value="${esc(u.email)}" required></div></section>
        ${accessCard(edit, u, "staff")}
        <div class="form-f sticky"><a class="btn ghost" href="#/team">Cancel</a><button class="btn" type="submit">${icon("check")}${edit.id ? "Save changes" : "Add and create their sign-in"}</button></div>
      </form></div>`;
  }
  const c = t.clinicians.find((x) => x.id === edit.id) || { name: "", role: "Optometrist", color: "#0089CF", areaName: "", patch: [], near: [], base: "", email: "", active: true, hours: WD().map(() => [dayS(), dayE()]) };
  const opts = (sel) => quarters().map((m) => `<option value="${m}" ${m === sel ? "selected" : ""}>${hm(m)}</option>`).join("");
  const f = (k, label, v, extra = "", hint = "") => `<div class="field"><label for="tm-${k}">${label}</label>${hint ? `<span class="hint">${hint}</span>` : ""}<input class="input" id="tm-${k}" value="${esc(v || "")}" ${extra}></div>`;
  return `<div class="pg narrow">${pageHead({ crumbs: crumbsOf([["#/team", "Team & hours"], ["", c.name || "New clinician"]]), eyebrow: edit.id ? esc(c.role) : "New clinician", title: esc(c.name || "Add a clinician"),
      lead: edit.id ? "Changes reach booking, refills and route planning straight away." : "They can sign in as soon as you save." })}
    <form id="tm-clin" data-id="${esc(edit.id || "")}" class="pg-form">
      <section class="card"><div class="card-h"><h2>Profile</h2><p>How they appear in the diary and on patients' texts.</p></div>
        <div class="row2">${f("name", "Full name", c.name, 'maxlength="60" required')}<div class="field"><label for="tm-role">Role</label><span class="hint">Only optometrists are offered eye examinations.</span><select class="input" id="tm-role">${t.roles.map((r) => `<option ${r === c.role ? "selected" : ""}>${r}</option>`).join("")}</select></div></div>
        <div class="row2">${f("email", "Signs in with (email)", c.email, 'type="email" required')}<div class="field"><label for="tm-color">Colour in the diary</label><input class="input" id="tm-color" type="color" value="${esc(c.color)}" style="height:46px;padding:4px"></div></div>
        <label class="chk"><input type="checkbox" id="tm-office" ${c.office ? "checked" : ""}><span><b>Also runs the practice</b> <span class="muted">(for a director: office access to every diary, patient and setting, as well as their own round)</span></span></label></section>
      <section class="card"><div class="card-h"><h2>Area</h2><p>Who they're offered: patients in these postcode areas first, then the ones they'll also go to.</p></div>
        ${f("area", "Area name", c.areaName, 'maxlength="60" placeholder="e.g. Bolton & Bury"')}
        <div class="row2">${f("patch", "Postcode areas they cover", c.patch.join(", "), 'placeholder="BL1, BL2, BL3"', "Separate with commas.")}${f("near", "Will also go to", c.near.join(", "), 'placeholder="BL4, M8"', "Used when nobody nearer fits.")}</div>
        ${f("base", "Starts the day from (postcode)", c.base, 'placeholder="BL1 5DN"', "Route planning starts and ends here.")}</section>
      <section class="card"><div class="card-h"><h2>Working hours</h2><p>Untick a day for a day off. If booked visits fall outside new hours, Domi names them so they can be moved first.</p></div>
        <div class="hours lg">${WD().map((d, i) => { const h = c.hours[i]; return `<div class="hrow"><label class="chk"><input type="checkbox" id="tm-w${i}" ${h ? "checked" : ""}> ${esc(DAY_LONG[i] || d.slice(0, 3))}</label>
          <select class="input" id="tm-s${i}" aria-label="${esc(d)} start">${opts(h ? h[0] : dayS())}</select><span class="muted">to</span><select class="input" id="tm-e${i}" aria-label="${esc(d)} finish">${opts(h ? h[1] : dayE())}</select></div>`; }).join("")}</div></section>
      ${accessCard(edit, c, "clin")}
      <div class="form-f sticky"><a class="btn ghost" href="#/team">Cancel</a><button class="btn" type="submit">${icon("check")}${edit.id ? "Save changes" : "Add and create their sign-in"}</button></div>
    </form></div>`;
}
const DAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
/** The next `n` open days from `from`. */
const openAhead = (from, n) => (S && S.cal ? S.cal.days.filter((x) => x.open && x.day >= from).slice(0, n).map((x) => x.day) : [0, 1, 2, 3, 4]);
/** Where someone's sign-in stands, as a badge for the team lists. Nothing once it's set up. */
const signinBadge = (si) => !si || si.state === "ready" ? "" : si.state === "expired" ? `<span class="badge b-warn">Invite expired</span>` : si.state === "reset" ? `<span class="badge b-plain">Reset sent</span>` : `<span class="badge b-plain">Invited</span>`;
/** "2 hours ago", "in 7 days": invite links run on real time, even in the demo. */
function relTime(ms) {
  const d = ms - Date.now(), a = Math.abs(d), u = a < 3600e3 ? [Math.max(1, Math.round(a / 60e3)), "minute"] : a < 864e5 ? [Math.round(a / 3600e3), "hour"] : [Math.round(a / 864e5), "day"];
  const t = `${u[0]} ${u[1]}${u[0] === 1 ? "" : "s"}`;
  return d >= 0 ? "in " + t : t + " ago";
}
function accessCard(edit, x, kind) {
  if (!edit.id) return `<section class="card"><div class="card-h"><h2>Sign-in</h2><p>When you save, they're emailed a link to choose their own password and set up an authenticator app on their phone. It takes them about two minutes, and nobody else ever knows either. The link works once and lasts 7 days.</p></div></section>`;
  const uid = kind === "clin" ? x.userId : x.id, si = x.signin || { state: "ready" }, me = !!S.signedInAs && uid === S.signedInAs.id;
  const inv = UI.pg && UI.pg.invite && UI.pg.invite.email === x.email ? UI.pg.invite : null;
  const what = si.kind === "reset" ? "reset link" : "invitation";
  const status = !x.active ? "Switched off: they can't sign in. Their history is kept."
    : si.state === "ready" ? "Signs in with their own password and a code from their authenticator app."
    : si.state === "expired" ? `The ${what} expired ${relTime(si.expiresAt)} before they used it. Send a new link.`
    : si.state === "reset" ? `Sign-in reset ${relTime(si.sentAt)}: the old password and codes no longer work. The new link expires ${relTime(si.expiresAt)}.`
    : `Invitation sent ${relTime(si.sentAt)}. They haven't set up their sign-in yet. The link expires ${relTime(si.expiresAt)}.`;
  const box = inv ? `<div class="invite-box" role="status">
      <div class="caps">${inv.kind === "invite" ? "Invitation link" : "Reset link"}</div>
      <p>${inv.emailed ? `Emailed to <b>${esc(inv.email)}</b>. You can also send it yourself.` : `Email isn't set up${META.demo ? " in this demo" : " yet"}, so send ${esc(first(x.name))} this link yourself, by text or WhatsApp.`} It works once, for ${inv.kind === "invite" ? "7 days" : "24 hours"}, and isn't shown again after you leave this page.</p>
      <div class="copy-row"><input class="input mono" readonly value="${esc(inv.url)}" aria-label="The link" id="invite-url"><button class="btn secondary" type="button" data-act="copy-invite">${icon("copy")}Copy</button></div>
      ${META.demo ? `<p class="muted" style="margin:10px 0 0;font-size:13px">Demo: open it in a private window to see what ${esc(first(x.name))} sees. <a href="${esc(inv.url)}" target="_blank" rel="noopener">Open the link</a></p>` : ""}
    </div>` : "";
  const act = x.active && !me ? (si.state === "ready"
      ? `<button class="btn secondary" type="button" data-act="tm-invite" data-id="${esc(uid)}" data-reset="1">${icon("reset")}Reset sign-in</button>`
      : `<button class="btn secondary" type="button" data-act="tm-invite" data-id="${esc(uid)}">${icon("send")}Send a new link</button>`) : "";
  return `<section class="card"><div class="card-h"><h2>Sign-in</h2><p>${status}</p></div>
    ${box}
    ${si.state === "ready" && x.active && !me ? `<p class="set-note" style="margin-top:0">Lost phone or forgotten password? Resetting stops their old password and codes at once, signs them out everywhere, and sends them a link to set up new ones.</p>` : ""}
    ${me ? `<p class="set-note" style="margin-top:0">This is you. To reset your own sign-in, ask another office account.</p>` : ""}
    <div class="acc-acts">${act}<button class="btn ${x.active ? "ghost danger-t" : "secondary"}" type="button" data-act="tm-active" data-k="${kind}" data-id="${esc(edit.id)}" data-v="${x.active ? 0 : 1}">${x.active ? "Switch off and sign out everywhere" : "Switch back on"}</button></div></section>`;
}

/* ============ Drawers ============ */
function openDrawer(d) { UI.drawer = d; redraw(); }
function closeDrawer() { UI.drawer = null; UI.flow = null; UI.book = null; UI.imp = null; /* the file stays only as long as the drawer is open */ $("#drawer-root").innerHTML = ""; }
/** Redraws the open side panel, or the page when the tool is open as a page. */
const redraw = () => (UI.drawer ? renderDrawer() : render());
/** A tool's state, whether it is open as a side panel or as its own page. */
const panel = (k) => (UI.drawer && UI.drawer.kind === k ? UI.drawer : UI.pg && UI.pg.kind === k ? UI.pg : null);
function renderDrawer() {
  const d = UI.drawer; if (!d || (!S && d.kind !== "soon")) return;
  let inner = "";
  if (d.kind === "appt") inner = apptDrawer(d.id);
  else if (d.kind === "flow") inner = flowDrawer();
  else if (d.kind === "wl") inner = wlDrawer();
  else if (d.kind === "book") inner = bookDrawer();
  else if (d.kind === "import") inner = importDrawer();
  else if (d.kind === "qr") inner = qrModal();
  else if (d.kind === "route") inner = routeDrawer(d.data);
  else if (d.kind === "plans") inner = plansDrawer(d);
  else if (d.kind === "referral") inner = referralDrawer(d);
  else if (d.kind === "lead") inner = leadDrawer(d);
  else if (d.kind === "lead-email") inner = leadEmailDrawer(d);
  else if (d.kind === "booklink") inner = bookLinkModal();
  else if (d.kind === "report") inner = reportDrawer(d.data);
  else if (d.kind === "invoices") inner = invoicesDrawer(d.data);
  else if (d.kind === "soon") inner = soonModal(d.id);
  else if (d.kind === "patients") inner = patientsDrawer(d);
  else if (d.kind === "patient") inner = patientDrawer(d);
  else if (d.kind === "move") inner = moveDrawer(d);
  else if (d.kind === "gap") inner = gapDrawer(d);
  else if (d.kind === "team") inner = teamDrawer(d);
  if (!inner) { closeDrawer(); return; }
  const root = $("#drawer-root");
  const html = d.kind === "qr" || d.kind === "booklink" || d.kind === "soon" ? `<div class="scrim" data-act="close"></div><div class="modal" role="dialog" aria-modal="true" aria-label="Open on phone">${inner}</div>`
    : `<div class="scrim" data-act="close"></div><aside class="drawer" role="dialog" aria-modal="true">${inner}</aside>`;
  const fresh = !root.firstChild;
  paint(root, html);
  mountMaps(root);
  if (fresh) { const f = root.querySelector("select, button:not(.x), input"); if (f) f.focus({ preventScroll: true }); }
}
/* ---------- Route map: drawn here from coordinates, so it needs no map service and works offline ---------- */
const mins = (m) => m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + " min" : ""}`.trim() : `${m} min`;
/* ---------- Route maps ----------
   On a real street map (OpenStreetMap, faded so the route stands out), with the route along the roads when
   road routing is available and dashed straight lines when it isn't. Pins are numbered in visiting order and
   match the numbered list underneath. Offline, or before the map library loads, the simple drawing below
   (svgRouteMap) is shown instead, so the clinician's phone never loses its route. */
const MAPS = new Map();      // key -> { el, map, sig }: Leaflet maps kept between redraws
const MAP_DATA = new Map();  // key -> the route it shows
let tileFailures = 0;
const tilesOk = () => !!window.L && navigator.onLine !== false && !UI.offline && tileFailures < 6;
function routeMap(r, { height = 300 } = {}) {
  const key = `${r.clinician.id}-${r.day}${r.stops.some((s) => s.proposed) ? "-p" : ""}-${height}`;
  MAP_DATA.set(key, r);
  return `<div class="lmap-slot" data-map="${esc(key)}" style="height:${height}px">${tilesOk() ? "" : svgRouteMap(r, { height })}</div>`;
}
const pinHtml = (label, cls, color) => `<span class="pin ${cls}" style="--pin:${color}">${label}</span>`;
function buildMap(el, r) {
  const map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.25, attributionControl: true });
  // OpenStreetMap refuses tiles to requests that don't say which site they're for, and Domi's pages send no
  // referrer by default. Tiles alone send the site's origin (never a page address).
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, className: "lmap-tiles", referrerPolicy: "origin", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' + (/openrouteservice/.test((typeof META !== "undefined" && META && META.routing) || "") ? ' · routes &copy; <a href="https://openrouteservice.org" target="_blank" rel="noopener">openrouteservice.org</a> by HeiGIT' : "") })
    .on("tileerror", () => { tileFailures++; }).addTo(map);
  map.attributionControl.setPrefix(false);
  const col = r.clinician.color, base = [r.base.lat, r.base.lon], pts = r.stops.map((s) => [s.lat, s.lon]);
  if (r.path && r.path.length > 1) {
    L.polyline(r.path, { color: "#fff", weight: 9, opacity: 0.9 }).addTo(map); // a white casing so the line reads on any street
    L.polyline(r.path, { color: col, weight: 5, opacity: 0.95 }).addTo(map);
  } else {
    L.polyline([base, ...pts], { color: col, weight: 4, opacity: 0.9, dashArray: "2 9", lineCap: "round" }).addTo(map);
    if (pts.length) L.polyline([pts[pts.length - 1], base], { color: col, weight: 3, opacity: 0.4, dashArray: "2 9", lineCap: "round" }).addTo(map);
  }
  const markers = [];
  const homeHtml = `<span class="pin home" title="Home base"><svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/></svg></span>`;
  const home = L.marker(base, { icon: L.divIcon({ className: "", html: homeHtml, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: -100 })
    .bindPopup(`<b>Home base</b><br>${esc(r.clinician.first)} starts and ends here`).addTo(map);
  home.pinHtml = homeHtml;
  r.stops.forEach((s, i) => {
    const cls = s.proposed ? "prop" : s.status === "done" ? "done" : s.status === "live" || s.status === "enroute" ? "is-live" : "";
    const m = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: pinHtml(s.proposed ? "+" : i + 1, cls, col), iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: s.proposed ? 1000 : 100 + i, riseOnHover: true })
      .bindPopup(`<b>${hm(s.start)} · ${esc(s.name)}</b><br>${esc(s.addr || "")}${s.addr ? ", " : ""}${esc(s.pc)}${s.proposed ? "<br><i>Proposed new visit</i>" : s.status === "done" ? "<br>Done" : ""}`)
      .addTo(map);
    m.pinHtml = pinHtml(s.proposed ? "+" : i + 1, cls, col);
    markers.push(m);
  });
  // Two visits a few doors apart would hide one pin under the other: at each zoom, nudge any pin that would
  // overlap one already placed, round in a small spiral. The pin's popup still points at the real address.
  const spread = () => {
    const placed = [];
    [home, ...markers].forEach((m) => {
      const p = map.latLngToLayerPoint(m.getLatLng());
      let dx = 0, dy = 0, k = 0;
      while (placed.some((q) => Math.hypot(q.x - p.x - dx, q.y - p.y - dy) < 27) && k < 12) { k++; const a = k * 2.4; dx = Math.cos(a) * 26; dy = Math.sin(a) * 26; }
      placed.push({ x: p.x + dx, y: p.y + dy });
      m.setIcon(L.divIcon({ className: "", html: m.pinHtml, iconSize: [30, 30], iconAnchor: [15 - dx, 15 - dy] }));
    });
  };
  // Room on the left for the zoom buttons, so no pin hides under them.
  map.fitBounds(L.latLngBounds([base, ...pts]), { paddingTopLeft: [56, 40], paddingBottomRight: [36, 36], maxZoom: 15 });
  spread(); map.on("zoomend", spread);
  return { map, markers };
}
/** After each redraw: put the live map into every slot, reusing it when the route hasn't changed. */
function mountMaps(root) {
  if (!tilesOk()) return;
  root.querySelectorAll(".lmap-slot[data-map]").forEach((slot) => {
    const key = slot.dataset.map, r = MAP_DATA.get(key);
    if (!r) return;
    const sig = JSON.stringify([r.stops.map((s) => [s.id, s.start, s.status, s.lat, s.lon]), r.path ? r.path.length : 0]);
    let m = MAPS.get(key);
    if (m && m.sig !== sig) { m.map.remove(); MAPS.delete(key); m = null; }
    if (!m) { const el = document.createElement("div"); el.className = "lmap"; slot.appendChild(el); m = { el, sig, ...buildMap(el, r) }; MAPS.set(key, m); }
    else if (m.el.parentNode !== slot) slot.appendChild(m.el);
    requestAnimationFrame(() => m.map.invalidateSize());
  });
}
/** Tapping a stop in the list opens its pin on the map. */
function focusStop(key, i) {
  const m = MAPS.get(key);
  if (!m || !m.markers[i]) return;
  m.map.flyTo(m.markers[i].getLatLng(), Math.max(m.map.getZoom(), 14), { duration: 0.6 });
  m.markers[i].openPopup();
}
function svgRouteMap(r, { height = 300 } = {}) {
  const W = 480, H = height, pad = 42;
  const pts = [r.base, ...r.stops];
  const lat0 = pts.reduce((t, p) => t + p.lat, 0) / pts.length, cos = Math.cos(lat0 * Math.PI / 180);
  const xs = pts.map((p) => p.lon * cos), ys = pts.map((p) => p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const k = Math.min((W - pad * 2.8) / Math.max(maxX - minX, 0.004), (H - pad * 2) / Math.max(maxY - minY, 0.004));
  const ox = (W - (maxX - minX) * k) / 2, oy = (H - (maxY - minY) * k) / 2;
  const raw = (p) => [ox + (p.lon * cos - minX) * k, H - oy - (p.lat - minY) * k];
  // Markers at (nearly) the same place fan out around it, so each one can be read and tapped.
  const spots = [];
  const at = new Map(pts.map((p) => {
    const [x0, y0] = raw(p); let x = x0, y = y0, n = 0;
    while (spots.some(([px, py]) => Math.hypot(px - x, py - y) < 28) && n < 16) { n++; const a = n * 2.4, d = 30 + n * 4; x = x0 + Math.cos(a) * d; y = y0 + Math.sin(a) * d; }
    spots.push([x, y]);
    return [p, [x, y]];
  }));
  const P = (p) => at.get(p);
  // Labels: first free spot among right / left / above / below; skipped if none is free (the list below has it all).
  const boxes = spots.map(([x, y]) => [x - 13, y - 13, x + 13, y + 13]);
  const hit = (b) => b[0] < 2 || b[2] > W - 2 || b[1] < 2 || b[3] > H - 2 || boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  const label = (x, y, text, cls, size = 7.4) => {
    const w = text.length * size, tries = [[x + 16, y + 4, "start"], [x - 16, y + 4, "end"], [x, y - 17, "middle"], [x, y + 25, "middle"]];
    for (const [tx, ty, anchor] of tries) {
      const x0 = anchor === "start" ? tx : anchor === "end" ? tx - w : tx - w / 2, b = [x0, ty - 12, x0 + w, ty + 3];
      if (!hit(b)) { boxes.push(b); return `<text x="${tx}" y="${ty}" text-anchor="${anchor}" class="${cls}">${esc(text)}</text>`; }
    }
    return "";
  };
  const col = r.clinician.color, prop = "var(--apricot)";
  const seq = [r.base, ...r.stops, r.base];
  const lines = [], legLabels = [];
  seq.slice(1).forEach((to, i) => {
    const from = seq.at(i), [x1, y1] = P(from), [x2, y2] = P(to);
    const isHome = i === seq.length - 2, proposed = to.proposed || from.proposed, leg = isHome ? r.home : to.leg;
    lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${proposed ? prop : isHome ? "var(--muted)" : col}" stroke-width="${proposed ? 2.5 : 2}" ${proposed || isHome ? 'stroke-dasharray="6 5"' : ""} marker-end="url(#rm-${proposed ? "p" : isHome ? "h" : "c"})" opacity="${isHome ? 0.55 : 0.9}"/>`);
    if (leg && leg.min && Math.hypot(x2 - x1, y2 - y1) > 90) legLabels.push([(x1 + x2) / 2, (y1 + y2) / 2, `${leg.min} min`]);
  });
  const district = ""; // the numbered list under the map names every stop; the drawing stays uncluttered
  const [bx, by] = P(r.base);
  const stopLabels = r.stops.map((st) => { const [x, y] = P(st); return label(x, y, hm(st.start), "rm-label" + (st.proposed ? " prop" : "")); });
  const baseLabel = label(bx, by, "Home base", "rm-label quiet");
  const legText = ""; // drive minutes are in the list under the map, not on the lines
  const stops = r.stops.map((st, i) => {
    const [x, y] = P(st), fill = st.proposed ? prop : st.status === "done" ? "var(--muted)" : col;
    return `<g class="rm-stop"><circle cx="${x}" cy="${y}" r="11" fill="${fill}" stroke="var(--surface)" stroke-width="2.5"/><text x="${x}" y="${y + 4}" text-anchor="middle" class="rm-num">${st.proposed ? "+" : i + 1}</text>${stopLabels.at(i)}</g>`;
  }).join("");
  return `<svg class="routemap" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of ${esc(r.clinician.first)}'s round: ${r.totals.visits} visits, ${mins(r.totals.driveMin)} driving">
    <defs>${[["c", col], ["p", prop], ["h", "var(--muted)"]].map(([id, c]) => `<marker id="rm-${id}" viewBox="0 0 10 10" refX="21" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`).join("")}</defs>
    <rect x="0" y="0" width="${W}" height="${H}" rx="14" class="rm-bg"/>
    ${district}${lines.join("")}${legText}
    <g><rect x="${bx - 11}" y="${by - 11}" width="22" height="22" rx="6" fill="var(--ink)"/><path d="M${bx - 6} ${by + 1}l6 -6l6 6v6h-12z" fill="var(--surface)"/>${baseLabel}</g>
    ${stops}
  </svg>`;
}
function routeSummary(r, { height = 300 } = {}) {
  const key = [...MAP_DATA.keys()].reverse().find((k) => MAP_DATA.get(k) === r) || "";
  const col = r.clinician.color;
  return `<div class="rm-totals"><span><b>${r.totals.visits}</b> visits</span><span><b>${mins(r.totals.driveMin)}</b> driving</span><span><b>${r.totals.miles}</b> miles (est.)</span></div>
    <ol class="rm-legs">${r.stops.map((st, i) => `<li class="${st.proposed ? "prop" : ""} ${st.status === "done" ? "done" : ""}"><button type="button" class="rm-row" data-act="map-focus" data-map="${esc(key)}" data-i="${i}">
        ${pinHtml(st.proposed ? "+" : i + 1, st.proposed ? "prop" : st.status === "done" ? "done" : st.status === "live" || st.status === "enroute" ? "is-live" : "", col)}
        <span class="rm-what"><b>${esc(st.name)}</b><span class="muted">${hm(st.start)}${st.proposed ? " · proposed" : st.status === "done" ? " · done" : ""} · ${esc(st.pc)}</span></span>
        <span class="rm-drive">${icon("car")}${st.leg.min ?? "?"} min<small>${st.leg.miles} mi${st.leg.source === "road" ? "" : " est."}</small></span></button></li>`).join("")}
      ${r.stops.length ? `<li class="home"><div class="rm-row"><span class="pin home sm"><svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/></svg></span><span class="rm-what"><b>Back to base</b><span class="muted">from ${hm(r.stops.at(-1).end)}</span></span><span class="rm-drive">${icon("car")}${r.home.min} min<small>${r.home.miles} mi</small></span></div></li>` : ""}</ol>`;
}
async function openRoute(cid, day) {
  const data = await api("GET", `/api/route?clinician=${encodeURIComponent(cid)}&day=${day}`);
  openDrawer({ kind: "route", data });
}
function routeDrawer(r) {
  const d = UI.drawer, plan = d.plan;
  return `<div class="drawer-h"><div><div class="caps">${esc(r.day === 0 ? "Today" : dayName(r.day))}</div><h2 style="margin-top:6px">${esc(r.clinician.first)}'s route</h2></div>${closeX}</div>
    <div class="drawer-b">${d.applied ? `<div class="callout forest" style="margin-bottom:14px">${icon("check")}<div><b>Route re-planned</b><div style="margin-top:2px">${d.applied.changed} patient${d.applied.changed === 1 ? "" : "s"} texted their new time; ${esc(r.clinician.first)}'s phone has the new order.</div></div></div>` : ""}
      ${plan ? planView(plan) : ""}
      ${r.stops.length ? routeMap(r) + routeSummary(r) : `<div class="empty"><b>No visits</b>Nothing booked on this day.</div>`}
      <p class="muted" style="font-size:12.5px;margin-top:14px">Drive times are road routes between the patients' postcodes where available, otherwise estimated from distance. Miles are estimated from distance.</p></div>
    ${isAdmin() && r.stops.length && !plan ? `<div class="drawer-f"><button class="btn" type="button" data-act="plan-route" data-c="${r.clinician.id}" data-d="${r.day}">${icon("pin")}Plan the best route</button></div>` : ""}`;
}
/** The proposed order: what it saves, who moves, and anything to check before applying. */
function planView(p) {
  if (!p.changed) return `<div class="callout" style="margin-bottom:14px">${icon("check")}<div><b>This is already a good order</b><div style="margin-top:2px">No other order saves ten minutes or more of driving, so nobody needs a new time.</div></div></div>`;
  return `<section class="plan-card">
    <div class="plan-head"><div><div class="caps">Proposed order</div><b>${mins(p.savedMin)} less driving${p.savedMiles > 0 ? `, ${p.savedMiles} fewer miles` : ""}</b></div>
      <div class="plan-tot"><span>Now <b>${mins(p.before.driveMin)}</b></span><span>Planned <b>${mins(p.after.driveMin)}</b></span></div></div>
    <ol class="plan-list">${p.fixed.map((f) => `<li class="fixed"><span class="mono">${hm(f.start)}</span><span>${esc(f.name)}</span><span class="muted">${f.status === "done" ? "Done" : "Under way"}: stays</span></li>`).join("")}
      ${p.planned.map((x) => `<li class="${x.moved ? "moved" : ""}"><span class="mono">${hm(x.start)}</span><span>${esc(x.name)}</span><span class="muted">${x.moved ? `was ${hm(x.from)}` : "same time"}</span></li>`).join("")}</ol>
    ${p.warnings.length ? `<div class="ir-m" style="margin:8px 0 0">${p.warnings.map((w) => `<span>${esc(w)}</span>`).join("")}</div>` : ""}
    <p class="muted" style="font-size:12.5px;margin:10px 0 0">Mornings stay mornings and afternoons stay afternoons. Each patient whose time changes gets a text with the new time and can reply NO.</p>
    <div class="plan-actions"><button class="btn ghost sm" type="button" data-act="plan-cancel">Keep it as it is</button><button class="btn sm" type="button" data-act="plan-apply" data-c="${p.clinicianId}" data-d="${p.day}">${icon("check")}Apply and text ${p.changed} patient${p.changed === 1 ? "" : "s"}</button></div>
  </section>`;
}
/* ---------- Every clinician's route for one day, planned at once ---------- */
function plansDrawer(d) {
  const day = d.day, list = d.list;
  const total = list ? list.reduce((t, p) => t + (p.changed ? p.savedMin : 0), 0) : 0;
  return `<div class="drawer-h"><div><div class="caps">Route planning</div><h2 style="margin-top:6px">Plan the rounds</h2></div>${closeX}</div>
    <div class="drawer-b">
      <p class="muted" style="margin:0 0 12px;font-size:13.5px">Domi puts each clinician's visits in the order that drives least, from their home base and back, keeping mornings in the morning and afternoons in the afternoon. Nothing changes until you apply it.</p>
      <div class="seg imp-filter" role="group" aria-label="Day">${openAhead(0, 5).map((i) => `<button type="button" data-act="plans-day" data-v="${i}" aria-pressed="${i === day}">${i === 0 ? "Today" : esc(dayName(i).slice(0, dayName(i).lastIndexOf(" ")))}</button>`).join("")}</div>
      ${!list ? `<p class="muted">Planning…</p>` : `${total ? `<div class="callout forest" style="margin-bottom:12px">${icon("car")}<div><b>${mins(total)} less driving ${day === 0 ? "today" : "on " + esc(dayName(day))}</b><div style="margin-top:2px">Across ${list.filter((p) => p.changed).length} clinician${list.filter((p) => p.changed).length === 1 ? "" : "s"}.</div></div></div>` : ""}
        ${list.map((p) => `<div class="plan-row"><span class="avatar sm" style="background:${(cln(p.clinicianId) || {}).color}">${initials(p.clinician)}</span>
          <div style="min-width:0;flex:1"><b>${esc(p.clinician)}</b><div class="muted" style="font-size:12.5px">${p.planned.length + p.fixed.length} visits · ${p.changed ? `${mins(p.savedMin)} less driving, ${p.changed} new time${p.changed === 1 ? "" : "s"}` : p.applied ? "Planned" : "Already a good order"}</div>${p.warnings.length ? `<div class="ir-m">${p.warnings.map((w) => `<span>${esc(w)}</span>`).join("")}</div>` : ""}</div>
          ${p.applied ? `<span class="badge b-ok">Applied</span>` : `<button class="btn secondary sm" type="button" data-act="route" data-c="${p.clinicianId}" data-d="${day}">${icon("pin")}See</button>${p.changed ? `<button class="btn sm" type="button" data-act="plans-apply" data-c="${p.clinicianId}">${icon("check")}Apply</button>` : ""}`}</div>`).join("")}`}
    </div>
    ${list && list.some((p) => p.changed && !p.applied) ? `<div class="drawer-f"><button class="btn" type="button" data-act="plans-apply-all">${icon("check")}Apply all and text patients</button></div>` : ""}`;
}
async function loadPlans(day) {
  const P = panel("plans"); if (!P) return;
  P.day = day; P.list = null; redraw();
  const cs = S.clinicians;
  P.list = await Promise.all(cs.map((c) => api("GET", `/api/route/plan?clinician=${c.id}&day=${day}`)));
  redraw();
}
/* ---------- What's coming: placeholders for features not built yet, clearly labelled ---------- */
// Nothing here pretends to work: each button opens a short note on what's coming. No dates are promised.
// "next" = smaller pieces to come first; "later" = bigger pieces that depend on partners or more work.
const ROADMAP = [
  { id: "persist", when: "golive", area: "Platform", title: "Your data kept for good, hosted in the UK", body: "A permanent database in a UK data centre, encrypted, with daily backups and tested restores. This demo resets on purpose." },
  { id: "reset", when: "golive", area: "Sign-in", title: "Invitations, password reset and your own authenticator", body: "New staff are emailed an invitation to set their own password and link their own authenticator app, with recovery codes and reset by email." },
  { id: "exam", when: "clinical", area: "Records", title: "The eye-exam record on the clinician's phone", body: "History and symptoms, vision, refraction, pressures, the eye health check and referrals, recorded during the visit. The new prescription and recall interval feed straight into recalls." },
  { id: "pcse-online", when: "clinical", area: "NHS claims", title: "NHS claims and notifications sent to PCSE", body: "Lodge and cancel pre-visit notifications, and send GOS sight test claims and vouchers, straight from Domi, with a list of claims still to submit, oldest first. Needs PCSE to approve Domi as a connected system." },
  { id: "glasses", when: "clinical", area: "Glasses", title: "Glasses from order to fitting", body: "Each pair followed through the lab and back, with the fitting visit offered and booked the day they arrive." },
  { id: "carevisit", when: "clinical", area: "Care homes", title: "Care-home visits", body: "Several residents seen on one visit, under one notification, with the three-week notice PCSE needs for three or more people at one address." },
  { id: "import", when: "later", area: "Getting started", title: "Bring visits and the waiting list across", body: "Patients can already be imported from a spreadsheet. Next: upcoming visits and the waiting list too, so nothing has to be typed in twice." },
  { id: "images", when: "later", area: "Records", title: "Fundus photos and scans", body: "Photos from a handheld fundus camera, and scan reports, saved into the patient's record from the clinician's phone." },
  { id: "letters", when: "later", area: "Records", title: "Letters and pre-visit forms", body: "GP and referrer letters from templates, and forms patients or carers fill in before the visit (consent, history), saved to the record." },
  { id: "ai-notes", when: "later", area: "Records", title: "Draft notes with AI", body: "Dictate or record the visit and get a draft note to check and save. Nothing is saved without the clinician approving it." },
  { id: "card", when: "later", area: "Payments", title: "Take card payments on the doorstep", body: "Take a card payment on the clinician's phone or a card reader at the end of the visit, marked paid on the invoice straight away." },
  { id: "xero", when: "later", area: "Payments", title: "Sync invoices to Xero or QuickBooks", body: "Invoices and payments flow into your accounts package, so nothing is typed in twice." },
  { id: "carehome", when: "later", area: "Payments", title: "Care-home billing", body: "Bill a care home for several residents seen on one visit, on one invoice." },
  { id: "stock", when: "later", area: "Practice", title: "Frame stock", body: "The frames each clinician carries in the car, with what's been sold and what to restock." },
  { id: "apps", when: "later", area: "Clinicians", title: "iPhone and Android apps", body: "The clinician app in the App Store and Google Play. Today it runs in the phone's browser, installs to the home screen and works offline." },
];
const RM = Object.fromEntries(ROADMAP.map((r) => [r.id, r]));
const RM_GROUPS = {
  golive: { short: "Comes with going live", title: "Comes with going live", lead: "Part of setting your practice up for real patients." },
  clinical: { short: "Next", title: "Next: eye-exam records and NHS claims", lead: "Everything needed to run the clinical side in Domi too, so one system does it all." },
  later: { short: "Later", title: "Later", lead: "Planned, in no fixed order. Tell us which matter most to you." },
};
/** Everything planned but not built, in one place on the office side. The clinicians' phones don't show any of it. */
function comingSoonPage() {
  const group = (k) => `<section class="pg-sec"><div class="sec-h"><h2>${RM_GROUPS[k].title}</h2><span class="muted">${ROADMAP.filter((r) => r.when === k).length} items</span></div><p class="muted" style="margin:0">${RM_GROUPS[k].lead}</p>
    <div class="rm-cards">${ROADMAP.filter((r) => r.when === k).map((r) => `<article class="rm-card" id="rm-${r.id}"><span class="rm-area">${esc(r.area)}</span><h3>${esc(r.title)}</h3><p>${esc(r.body)}</p></article>`).join("")}</div></section>`;
  return `<div class="pg">${pageHead({ eyebrow: "Roadmap", title: "Coming soon", lead: "What's planned but not in Domi yet. Nothing on this page works today. Buttons marked Soon around the office open these notes; the clinicians' phones don't show any of it." })}
    ${group("golive")}${group("clinical")}${group("later")}</div>`;
}
/** A placeholder button for something not built yet: says so, and explains when clicked. */
const soon = (id, label, ic = "bolt", cls = "btn secondary sm") => `<button class="${cls} soon" type="button" data-act="soon" data-id="${id}">${icon(ic)}${label}<span class="soon-pill">Soon</span></button>`;
function soonModal(id) {
  const r = RM[id];
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><div><div class="caps">${esc(r.area)} · ${RM_GROUPS[r.when].short}</div><h2 style="margin-top:6px;font-size:28px">${esc(r.title)}</h2></div>${closeX}</div>
    <p style="margin:10px 0 0">${esc(r.body)}</p>
    <p class="muted" style="font-size:13px;margin:14px 0 0">${icon("clock")} Not in this demo yet.</p>
    <div style="display:flex;gap:8px;margin-top:16px">${S && isAdmin() ? `<button class="btn secondary sm" type="button" data-act="roadmap" data-v="${esc(id)}">See everything that's coming</button>` : ""}</div>`;
}
const closeX = `<button class="icon-btn" type="button" data-act="close" aria-label="Close">${icon("x")}</button>`;

function apptDrawer(id) {
  const a = S.appts.find((x) => x.id === id); if (!a) return "";
  const p = pat(a.patientId), t = T(a.type), c = cln(a.clinicianId);
  const canCancel = a.status === "booked" || a.status === "enroute";
  const status = { booked: ["b-forest", "Booked"], enroute: ["b-warn", "On the way"], live: ["b-ok", "With patient"], done: ["b-plain", "Done"], missed: ["b-plain", "Nobody in"] }[a.status] || ["b-plain", a.status];
  // Its time has passed but the clinician hasn't closed it: the office can record what happened.
  const recordable = isAdmin() && OPEN.includes(a.status) && (a.day || 0) === 0 && a.start <= demoNow();
  const tools = isAdmin() ? `<div class="appt-tools"><button class="btn secondary sm" type="button" data-act="open-rec" data-id="${p.id}">${icon("users")}Patient record</button>${a.status === "booked" ? `<button class="btn secondary sm" type="button" data-act="move" data-id="${a.id}">${icon("cal")}Move to another time</button><button class="btn secondary sm" type="button" data-act="cancel-link" data-id="${a.id}">${icon("copy")}Family cancel link</button>` : ""}</div>` : "";
  const record = recordable ? `<div class="hr" style="margin:20px 0"></div>
    <div class="caps">Record what happened</div>
    <p class="muted" style="margin:6px 0 12px;font-size:13.5px">If ${esc(c.first)} couldn't update the app. Nobody is texted.</p>
    <div class="field"><label for="rec-note">Note for the record</label><textarea class="input" id="rec-note" data-keep rows="2" maxlength="2000" placeholder="e.g. Glasses fitted and adjusted, comfortable."></textarea></div>
    <label class="chk" style="margin-bottom:12px"><input type="checkbox" id="rec-rebook" data-keep checked> If nobody was in, put ${esc(first(p.name))} back on the waiting list</label>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" data-act="record" data-v="done" data-id="${a.id}">${icon("check")}Visit completed</button><button class="btn secondary" type="button" data-act="record" data-v="missed" data-id="${a.id}">Nobody in</button></div>` : "";
  return `<div class="drawer-h"><div><div class="caps">${a.day ? dayName(a.day) + " · " : ""}${hm(a.start)}–${hm(a.start + t.dur)} · ${esc(c.name)}</div><h2 style="margin-top:6px">${esc(p.name)}</h2>
      <div style="display:flex;gap:6px;margin-top:8px"><span class="badge ${status[0]}">${status[1]}</span>${a.moved ? `<span class="badge b-apricot">${icon("bolt")}Moved forward</span>` : ""}</div></div>${closeX}</div>
    <div class="drawer-b">
      <dl class="kv"><dt>Visit</dt><dd>${t.name} · ${t.dur} min</dd>${p.obId ? `<dt>Opticabase</dt><dd class="mono">${esc(p.obId)}</dd>` : ""}<dt>Address</dt><dd>${esc(p.addr)}, ${esc(p.pc)}</dd><dt>Phone</dt><dd><span class="mono">${esc(p.phone)}</span> · prefers ${esc(p.contact.toLowerCase())}</dd><dt>Glasses</dt><dd>${esc(p.specs)}</dd>${p.alerts.length ? `<dt>Notes</dt><dd>${esc(p.alerts.join(". "))}</dd>` : ""}</dl>
      ${isAdmin() && ["booked", "enroute"].includes(a.status) ? `<div class="likely">
        <div class="field"><label for="ap-src">How they came to us</label><select class="input" id="ap-src" data-id="${a.id}">${Object.entries(META.sources || {}).map(([k, v]) => `<option value="${k}" ${k === a.source ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></div>
        <div class="field"><label for="ap-count">True count <span class="muted">(how likely they are to be in)</span></label><select class="input" id="ap-count" data-id="${a.id}">${(META.counts || [1, 0.5]).map((n) => `<option value="${n}" ${n === countOf(a) ? "selected" : ""}>${n}${n === ((META.sources || {})[a.source] || { count: 0.5 }).count ? " (usual for this source)" : ""}</option>`).join("")}</select></div></div>` : ""}
      ${tools}${record}
      ${canCancel ? `<div class="hr" style="margin:20px 0"></div>
        <div class="field"><label for="reason">Why is it cancelled?</label><select class="input" id="reason" data-keep>${META.reasons.map((r) => `<option>${r}</option>`).join("")}</select></div>
        <button class="btn danger block lg" type="button" data-act="do-cancel" data-id="${a.id}">${icon("x")}Cancel and refill this slot</button>
        <div class="callout plain" style="margin-top:16px">${icon("phone")}<div><b>Or play the patient</b><div class="muted" style="margin-top:2px">Most cancellations come in by text. Send "CANCEL" from ${esc(first(p.name))}'s phone and watch the slot refill with nobody in the office touching it.</div>
          <button class="btn ghost sm" style="margin-top:10px" type="button" data-act="patient-cancel" data-id="${p.id}">${icon("send")}Text CANCEL as ${esc(first(p.name))}</button></div></div>`
        : recordable ? "" : `<p class="muted" style="margin-top:20px">${a.status === "done" ? "This visit is complete." : a.status === "missed" ? "Nobody was in." : "The clinician is with this patient now."}</p>`}
    </div>`;
}

/* The refill story. Built from the API response, then kept current by live events. */
const roundFrom = (r) => ({ round: r.round, plan: r.plan, deadline: r.deadline, offers: (r.offers || []).map((o) => Object.assign({ status: "pending" }, o)) });
function flowFrom(r) {
  return {
    slotId: r.slotId, clinicianId: r.clinicianId, clinician: r.clinician, day: r.day || 0, start: r.start, window: r.window, plan: r.plan,
    cancelled: r.cancelled || {}, candidates: r.candidates || [],
    rounds: r.outcome === "offered" ? [roundFrom(r)] : [],
    outcome: r.outcome === "offered" ? null : r.outcome, booking: r.booking || null, why: r.why || null,
  };
}
const step = (state, title, desc, extra) => `<li class="step ${state}"><span class="ic">${icon(state === "ok" ? "check" : state === "wait" ? "spin" : state === "no" ? "x" : "send")}</span><div><div class="st">${title}</div>${desc ? `<div class="sd">${desc}</div>` : ""}${extra || ""}</div></li>`;
function planText(f) {
  const p = f.plan || {}, c = first(f.clinician || ""), lead = Math.round(f.start - demoNow());
  if (S.settings.mode === "instant") return `Instant mode: the best match is booked straight in and told by text.`;
  if (f.day > 0 && p.mode === "single") return `The visit is on ${dayName(f.day)}, so there's plenty of time: one person is asked at a time, with ${p.windowMin} min each to reply.`;
  if (p.mode === "parallel") return `The visit is ${lead} min away and ${c} needs to leave in time, so the top ${p.count} are asked at once. The first YES gets it.`;
  if (p.mode === "single") return `There's time, so one person is asked at a time with ${p.windowMin} min to reply. That leaves room for several rounds before ${c} sets off.`;
  return null;
}
function flowDrawer() {
  const f = UI.flow; if (!f) return "";
  const c = first(f.clinician);
  const steps = [];
  steps.push(step("ok", `${whenLabel(f.day, f.start)} slot freed`, `${esc(f.cancelled.patient || "The patient")} ${f.cancelled.byText ? "texted CANCEL" : f.cancelled.byLink ? "cancelled with the online link" : "cancelled: " + esc(String(f.cancelled.reason || "").toLowerCase())}. ${f.window} min free before ${esc(c)}'s next visit.`));
  const ranked = f.candidates.filter((x) => x.ok);
  steps.push(step(ranked.length ? "ok" : "no", ranked.length ? `${ranked.length} suitable on the waiting list` : "Nobody on the list fits", ranked.length ? "Ranked by priority, area, days waiting and preferred clinician." : "",
    `<div class="cands">${f.candidates.slice(0, 4).map((x, i) => `<div class="cand ${x.ok && i === 0 ? "top" : ""}"><span class="pos">${i + 1}</span><div style="min-width:0"><b>${esc(x.name)}</b> <span class="muted">· ${T(x.type).name}</span><div class="why">${x.ok ? x.why.map((w) => `<span>${esc(w)}</span>`).join("") : `<span>Not suitable: ${esc(x.reason)}</span>`}</div></div><span class="sc">${x.ok ? x.score + " pts" : "–"}</span></div>`).join("")}</div>`));
  f.rounds.forEach((r) => {
    const pending = r.offers.some((o) => o.status === "pending") && !f.outcome;
    const left = Math.max(0, Math.round(toMin(r.deadline) - demoNow()));
    const offers = r.offers.map((o) => {
      const chip = { pending: ["b-apricot", "Waiting for reply"], declined: ["b-plain", "Said no"], expired: ["b-plain", "No reply"], accepted: ["b-ok", "Said yes"], taken: ["b-plain", "Told it's gone"] }[o.status];
      return `<div class="offer ${o.status === "accepted" ? "accepted" : ""}"><div class="oh"><b>${esc(o.name)}</b><span class="badge ${chip[0]}">${chip[1]}</span></div>
        ${r.offers.length === 1 || o === r.offers[0] ? `<div class="ob">${esc(o.body)}</div>` : ""}
        ${o.status === "pending" && !f.outcome ? `<div class="oa"><span class="muted" style="font-size:12px;margin-right:auto;align-self:center">Demo: reply as ${esc(first(o.name))}</span><button class="btn soft sm" type="button" data-act="reply" data-p="${o.patientId}" data-v="No thanks, not today">NO</button><button class="btn sm" type="button" data-act="reply" data-p="${o.patientId}" data-v="Yes please">YES</button></div>` : ""}</div>`;
    }).join("");
    steps.push(step(pending ? "wait" : "ok", r.offers.length > 1 ? `Offered to ${r.offers.length} people at once` : `Offered to ${esc(r.offers[0].name)}`,
      pending ? `Replies close at ${esc(r.deadline)}${left ? ` (in ${left} min)` : ""}. If nobody says yes, the next people are asked automatically.` : "", `<div class="offers">${offers}</div>`));
  });
  if (f.outcome === "booked") steps.push(step("ok", `${esc(f.booking.patient)} booked for ${whenLabel(f.day, f.start)}`, `${esc(c)} has been texted and the visit is on the phone now.${f.booking.instant ? " Booked instantly." : ""}`));
  if (f.outcome === "unfilled") steps.push(step("no", "Slot left open", esc(f.why || "Nobody suitable could take it.") + ". It stays visible in the diary."));
  const note = planText(f);
  const ring = f.outcome !== "booked" && isAdmin() ? f.candidates.filter((x) => x.ok && x.byPhone) : [];
  if (ring.length) steps.push(step(f.outcome === "unfilled" ? "no" : "send", `${ring.map((x) => esc(x.name)).slice(0, 2).join(" and ")} asked to be phoned`, "They're never texted offers. Ring them, and book whoever says yes.",
    `<button class="btn secondary sm" style="margin-top:8px" type="button" data-act="gap" data-id="${f.slotId}">${icon("phone")}Ring and book</button>`));
  else if (f.outcome === "unfilled" && isAdmin()) steps.push(step("send", "Fill it by hand", "See everyone who'd fit, ring one and book them.", `<button class="btn secondary sm" style="margin-top:8px" type="button" data-act="gap" data-id="${f.slotId}">${icon("phone")}Who could take it</button>`));
  return `<div class="drawer-h"><div><div class="caps">${esc(f.clinician)} · ${whenLabel(f.day, f.start)}</div><h2 style="margin-top:6px">${f.outcome === "booked" ? "Slot refilled" : f.outcome === "unfilled" ? "Couldn't refill" : "Refilling the slot"}</h2></div>${closeX}</div>
    <div class="drawer-b">${note && f.rounds.length ? `<div class="callout forest">${icon("clock")}<div>${esc(note)}</div></div>` : ""}<ol class="steps">${steps.join("")}</ol></div>
    ${f.outcome ? `<div class="drawer-f">${f.outcome === "booked" ? `<button class="btn ghost" type="button" data-act="see-clin" data-c="${f.clinicianId}">See ${esc(c)}'s phone</button>` : ""}<button class="btn" type="button" data-act="close">Done</button></div>` : ""}`;
}
/* Book a visit: who, what, when they're home -> best slots across every round, ranked by extra driving. */
function bookInput() {
  const v = (id) => { const e = $("#" + id); return e ? e.value : ""; };
  return { patientId: v("bk-p"), name: v("bk-name"), pc: DomiAreas.read(document, "bk-pc"), addr: v("bk-addr"), phone: v("bk-phone"), type: v("bk-type"), avail: v("bk-avail"), date: v("bk-from") || undefined, source: v("bk-src") || undefined, early: !!($("#bk-early") || {}).checked, icb: v("bk-icb") || undefined };
}
/* ---------- Importing patients from a spreadsheet ---------- */
// The file is read in the browser and sent for checking; nothing is saved until the office presses Import.
const IMPORT_TEMPLATE = "First name,Surname,Date of birth,Address,Town,Postcode,Mobile,Other phone,Email,Reason for home visit,Next of kin,Next of kin phone,Access notes,Glasses,Last sight test,Notes\n";
function importDrawer() {
  const I = UI.imp || (UI.imp = {});
  const head = (cap, title) => `<div class="drawer-h"><div><div class="caps">${cap}</div><h2 style="margin-top:6px">${title}</h2></div>${closeX}</div>`;
  if (I.done) {
    const d = I.done;
    return `${head("Import finished", [d.imported && `${d.imported} added`, d.updated && `${d.updated} updated`].filter(Boolean).join(", ") || "Nothing changed")}<div class="drawer-b">
      <ol class="steps">
        ${d.imported ? `<li class="step ok"><span class="ic">${icon("check")}</span><div><div class="st">${d.imported} added to Domi</div><div class="sd">Each record notes it came from the import. Search for them under Patients.</div></div></li>` : ""}
        ${d.updated ? `<li class="step ok"><span class="ic">${icon("check")}</span><div><div class="st">${d.updated} brought up to date</div><div class="sd">Only what changed in the file was written, and each record notes what changed.</div></div></li>` : ""}
        ${d.same ? `<li class="step"><span class="ic">${icon("check")}</span><div><div class="st">${d.same} already up to date</div><div class="sd">Nothing to change.</div></div></li>` : ""}
        ${d.conflicts ? `<li class="step"><span class="ic">${icon("x")}</span><div><div class="st">${d.conflicts} not matched, left alone</div><div class="sd">Their Opticabase ID belongs to someone with a different date of birth on Domi. Check both records.</div></div></li>` : ""}
        ${d.recalls ? `<li class="step ok"><span class="ic">${icon("cal")}</span><div><div class="st">${d.recalls} due a sight test</div><div class="sd">They're on the recall list and in the refill pool, so a cancellation near them can go to them.</div></div></li>` : ""}
        ${d.duplicates ? `<li class="step"><span class="ic">${icon("copy")}</span><div><div class="st">${d.duplicates} skipped as already on Domi</div><div class="sd">Matched by mobile number, or name with postcode or date of birth.</div></div></li>` : ""}
        ${d.errors ? `<li class="step"><span class="ic">${icon("x")}</span><div><div class="st">${d.errors} skipped with problems</div><div class="sd">Fix them in the spreadsheet and import the file again: anyone already added is skipped next time.</div></div></li>` : ""}
      </ol>
      <div class="callout apricot" style="margin-top:16px">${icon("bolt")}<div><b>Using Opticabase as well?</b><div style="margin-top:2px">Import the same Opticabase export again whenever it suits, every morning for instance. Patients are matched by their Opticabase ID: new ones are added, changed addresses and numbers are updated, and nothing is entered twice.</div></div></div>
    </div><div class="drawer-f"><button class="btn ghost" type="button" data-act="import-again">Import another file</button><button class="btn" type="button" data-act="close">Done</button></div>`;
  }
  if (!I.pv) {
    return `${head("Getting started", "Import patients")}<div class="drawer-b">
      <p class="muted" style="margin:0 0 14px;font-size:13.5px">Bring your patient list across from a spreadsheet in one go. You'll see every row checked before anything is saved.</p>
      <ol class="imp-how">
        <li><b>Save your sheet as a CSV file.</b> Google Sheets: <i>File → Download → Comma-separated values</i>. Excel: <i>Save As → CSV UTF-8</i>.</li>
        <li><b>Choose the file below.</b> Domi works out which column is which; you can change any of them.</li>
        <li><b>Check the preview, then import.</b> Problems and possible duplicates are shown first, and skipped.</li>
        <li><b>From Opticabase? Import it again whenever you like.</b> Patients are matched by their Opticabase ID: new ones are added and changed details updated.</li>
      </ol>
      <label class="imp-drop" for="imp-file">${icon("copy")}<span><b>${I.busy ? "Checking…" : "Choose a CSV file"}</b><small>Up to 5,000 patients, 3 MB</small></span></label>
      <input type="file" id="imp-file" accept=".csv,text/csv" hidden>
      ${I.err ? `<div class="err" role="alert" style="margin-top:12px">${esc(I.err)}</div>` : ""}
      <p class="muted" style="font-size:12.5px;margin:14px 0 0">No spreadsheet yet, or want the ideal layout? <button class="linkish" type="button" data-act="import-template">Download a template</button>. Only a name and a postcode are required.</p>
      <p class="muted" style="font-size:12.5px;margin:8px 0 0">The file is checked in this demo only and isn't kept. Before importing real patients, the practice needs the live UK hosting and the data protection agreement in place.</p>
    </div>`;
  }
  const pv = I.pv, c = pv.counts, f = I.filter || "all";
  const fieldOpts = (cur) => `<option value="">Don't import</option>` + pv.fields.map((x) => `<option value="${x.key}" ${x.key === cur ? "selected" : ""}>${esc(x.label)}</option>`).join("");
  const shown = pv.rows.filter((r) => f === "all" || (f === "new" ? r.status === "ready" : f === "update" ? r.status === "update" : f === "same" ? r.status === "same" || r.status === "duplicate" : f === "problems" ? r.status === "error" || r.status === "conflict" : (r.status === "ready" || r.status === "update") && r.warnings.length));
  const badge = (r) => r.status === "error" ? `<span class="badge b-crit">Won't import</span>` : r.status === "conflict" ? `<span class="badge b-crit">Doesn't match</span>` : r.status === "duplicate" ? `<span class="badge b-plain">Already on Domi</span>` : r.status === "same" ? `<span class="badge b-plain">Up to date</span>` : r.status === "update" ? `<span class="badge b-forest">Update</span>` : r.warnings.length ? `<span class="badge b-warn">Check</span>` : `<span class="badge b-ok">New</span>`;
  const shownVal = (v) => v == null ? "nothing" : String(v);
  const LIMIT = 150;
  return `${head(`${esc(I.name || "Your file")} · ${c.total} row${c.total === 1 ? "" : "s"}`, "Check before importing")}<div class="drawer-b">
    ${pv.missing.length ? `<div class="err" role="alert" style="margin-bottom:12px">Choose which column holds ${esc(pv.missing.join(" and "))}.</div>` : ""}
    <details class="imp-map" ${pv.missing.length || I.openMap ? "open" : ""}><summary>Columns · ${pv.mapping.filter(Boolean).length} of ${pv.headers.length} used</summary>
      <table class="imp-cols"><thead><tr><th>Your column</th><th>Example</th><th>Goes into</th></tr></thead><tbody>
      ${pv.headers.map((h, i) => `<tr><td><b>${esc(h || "(no heading)")}</b></td><td class="muted">${esc(pv.samples[i] || "")}</td><td><select class="input sm imp-col" data-i="${i}" aria-label="Field for ${esc(h)}">${fieldOpts(pv.mapping[i])}</select></td></tr>`).join("")}
      </tbody></table></details>
    <div class="seg imp-filter" role="group" aria-label="Show rows">
      <button type="button" data-act="imp-filter" data-v="all" aria-pressed="${f === "all"}">All ${c.total}</button>
      <button type="button" data-act="imp-filter" data-v="new" aria-pressed="${f === "new"}">New ${c.ready}</button>
      <button type="button" data-act="imp-filter" data-v="update" aria-pressed="${f === "update"}">Updates ${c.update || 0}</button>
      <button type="button" data-act="imp-filter" data-v="same" aria-pressed="${f === "same"}">Already on Domi ${(c.same || 0) + c.duplicate}</button>
      <button type="button" data-act="imp-filter" data-v="warn" aria-pressed="${f === "warn"}">To check ${c.warnings}</button>
      <button type="button" data-act="imp-filter" data-v="problems" aria-pressed="${f === "problems"}">Won't import ${c.error + (c.conflict || 0)}</button>
    </div>
    <ul class="imp-rows">${shown.slice(0, LIMIT).map((r) => `<li class="${r.status}"><div class="ir-h"><span class="mono muted">Row ${r.line}</span><b>${esc(r.name || "(no name)")}</b><span class="muted">${esc(r.pc || "")}${r.age ? " · " + r.age : ""}</span>${badge(r)}</div>
      ${r.changes && r.changes.length ? `<div class="ir-m ir-ch">${r.changes.map((x) => `<span><b>${esc(x.label.charAt(0).toUpperCase() + x.label.slice(1))}</b>: ${esc(shownVal(x.from))} → ${esc(x.to)}</span>`).join("")}</div>` : ""}
      ${r.errors.length || r.warnings.length || r.duplicateOf || r.conflict ? `<div class="ir-m">${r.errors.map((m) => `<span class="e">${esc(m)}</span>`).join("")}${r.duplicateOf ? `<span>Same as ${esc(r.duplicateOf)}</span>` : ""}${r.conflict ? `<span class="e">${esc(r.conflict)}</span>` : ""}${r.warnings.map((m) => `<span>${esc(m)}</span>`).join("")}</div>` : ""}
      ${r.recallDue != null && r.recallDue <= 14 && r.status === "ready" ? `<div class="ir-m"><span class="ok">Sight test ${r.recallDue < 0 ? `overdue by ${-r.recallDue} days` : r.recallDue === 0 ? "due today" : `due in ${r.recallDue} days`}: will join recalls</span></div>` : ""}</li>`).join("")}
      ${shown.length > LIMIT ? `<li class="muted" style="text-align:center">…and ${shown.length - LIMIT} more</li>` : ""}${!shown.length ? `<li class="muted" style="text-align:center">Nothing here.</li>` : ""}</ul>
    ${I.err ? `<div class="err" role="alert" style="margin-top:12px">${esc(I.err)}</div>` : ""}
  </div>
  <div class="drawer-f"><button class="btn ghost" type="button" data-act="import-again">Choose another file</button><button class="btn" type="button" data-act="import-commit" ${!(c.ready + (c.update || 0)) || pv.missing.length || I.busy ? "disabled" : ""}>${icon("check")}${I.busy ? "Importing…" : [c.ready && `Add ${c.ready}`, c.update && `update ${c.update}`].filter(Boolean).join(" and ").replace(/^./, (x) => x.toUpperCase()) || "Nothing to import"}</button></div>`;
}
async function importPreview(mapping) {
  const I = UI.imp;
  I.busy = true; I.err = null; redraw();
  try { I.pv = await api("POST", "/api/import/preview", { csv: I.csv, mapping }); }
  catch (e) { I.err = e.message; if (!mapping) I.csv = null; }
  I.busy = false; redraw();
}
function bookDrawer() {
  const B = UI.book || (UI.book = {});
  if (B.done) {
    const d = B.done, c = cln(d.clinicianId);
    return `<div class="drawer-h"><div><div class="caps">Booked</div><h2 style="margin-top:6px">${esc(d.patient)} is booked</h2></div>${closeX}</div>
      <div class="drawer-b">
        <div class="callout forest">${icon("check")}<div><b>${d.day ? esc(d.dayLabel) + " · " : "Today · "}${esc(d.label)} with ${esc(d.clinician)}</b><div style="margin-top:2px">Adds about ${d.extraDrive} min of driving to ${esc(first(d.clinician))}'s round.</div></div></div>
        <ol class="steps">
          <li class="step ok"><span class="ic">${icon("check")}</span><div><div class="st">Visit added to the diary</div><div class="sd">The next visit's drive time has been updated to start from the new address.</div></div></li>
          <li class="step ok"><span class="ic">${icon("msg")}</span><div><div class="st">${esc(first(d.patient))} has been texted</div><div class="sd">With the time, and how to cancel by text if plans change.</div></div></li>
          <li class="step ok"><span class="ic">${icon("phone")}</span><div><div class="st">${esc(first(d.clinician))}'s phone has it now</div><div class="sd">A "New visit added" banner appears at the top of the day.</div></div></li>
        </ol>
      </div>
      <div class="drawer-f"><button class="btn ghost" type="button" data-act="see-clin" data-c="${c ? c.id : ""}">See ${esc(first(d.clinician))}'s phone</button><button class="btn ghost" type="button" data-act="book-again">Book another</button><button class="btn" type="button" data-act="close">Done</button></div>`;
  }
  const busy = new Set(S.appts.filter((a) => active(a) && a.status !== "done").map((a) => a.patientId));
  const waiting = new Set(S.waitlist.filter((w) => w.status !== "booked").map((w) => w.patientId));
  const opts = S.patients.filter((p) => !busy.has(p.id)).sort((a, b) => (waiting.has(b.id) - waiting.has(a.id)) || a.name.localeCompare(b.name));
  const sel = B.patientId || (opts[0] ? opts[0].id : "new");
  const results = B.results ? (B.results.slots.length
    ? `<div class="hr" style="margin:20px 0 14px"></div><div class="caps">Best slots for ${esc(B.results.patient.name)} · ${esc(B.results.patient.pc)}</div>
       <div class="offers">${B.results.slots.map((x, i) => { const c = cln(x.clinicianId); return `<div class="offer ${i === 0 ? "accepted" : ""}" style="${i === 0 ? "" : ""}">
         <div class="oh"><span style="display:flex;gap:10px;align-items:center"><span class="avatar sm" style="background:${c.color}">${initials(c.name)}</span><span><b class="mono">${x.day === 0 ? "Today" : esc(dayName(x.day))} · ${esc(x.label)}</b><div class="muted" style="font-size:12.5px">${esc(c.name)}</div></span></span>${i === 0 ? `<span class="badge b-ok">Best fit</span>` : `<span class="badge b-plain">+${x.extraDrive} min</span>`}</div>
         <div class="why">${x.why.map((w) => `<span>${esc(w)}</span>`).join("")}<span class="src ${x.route === "road" ? "road" : ""}" title="${x.route === "road" ? "Driving times from a road route between the two postcodes" : "No road route available, so this is estimated from the distance"}">${icon(x.route === "road" ? "car" : "pin")}${x.route === "road" ? "Road route" : "Estimated"}</span></div>
         ${B.map && B.map.i === i ? `<div class="slot-map">${routeMap(B.map.data, { height: 280 })}${routeSummary(B.map.data)}</div>` : ""}
         <div class="oa"><button class="btn secondary sm" type="button" data-act="slot-map" data-i="${i}">${icon("pin")}${B.map && B.map.i === i ? "Hide map" : "Map"}</button><button class="btn sm" type="button" data-act="book-slot" data-c="${x.clinicianId}" data-d="${x.day}" data-s="${x.start}">${icon("check")}Book ${x.day === 0 ? "" : esc(dayName(x.day).slice(0, 3)) + " "}${esc(x.label.slice(0, 5))}</button></div></div>`; }).join("")}</div>`
    : `<div class="callout apricot" style="margin-top:18px">${icon("clock")}<div><b>No gap ${B.results.from ? "from " + esc(B.results.fromLabel) + " " : ""}fits without a long detour</b><div style="margin-top:2px">Try a later earliest date above, or:</div><div style="margin-top:2px">Put ${esc(B.results.patient.name)} on the waiting list and they'll be offered the next cancellation nearby.</div>
       <button class="btn sm" style="margin-top:10px" type="button" data-act="book-waitlist">${icon("plus")}Add to waiting list</button></div></div>`)
    : "";
  return `<div class="drawer-h"><div><div class="caps">New home visit</div><h2 style="margin-top:6px">Book a visit</h2></div>${closeX}</div>
  <form class="drawer-b" id="book-form" novalidate>
    <p class="muted" style="margin:0 0 16px;font-size:13.5px">Searches every clinician's round over the next working days for gaps where this visit fits, using road driving times between the full postcodes for the drive in and the drive on to the next patient, and ranks them by the extra driving they add.</p>
    <div class="field"><label for="bk-p">Patient</label><select class="input" id="bk-p" data-keep>${opts.map((p) => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)} · ${esc(p.pc)}${waiting.has(p.id) ? " · on waiting list" : ""}</option>`).join("")}<option value="new" ${sel === "new" ? "selected" : ""}>New patient…</option></select></div>
    <div id="bk-new" ${sel === "new" ? "" : "hidden"}><div class="row2"><div class="field"><label for="bk-name">Name</label><input class="input" id="bk-name" data-keep placeholder="e.g. Ruth Ingham"></div><div class="field"><label for="bk-addr">Address</label><input class="input" id="bk-addr" data-keep placeholder="House and street"></div></div>
      <div class="field">${DomiAreas.picker(S.areas || [], "bk-pc", DomiAreas.read(document, "bk-pc"))}</div>
      <div class="row2"><div class="field"><label for="bk-phone">Mobile</label><input class="input" id="bk-phone" data-keep placeholder="07700 900000" inputmode="tel"></div></div></div>
    <div class="row2"><div class="field"><label for="bk-type">Visit type</label><select class="input" id="bk-type" data-keep>${Object.entries(TYPES_NOW()).map(([k, v]) => `<option value="${k}">${v.name} · ${v.dur} min</option>`).join("")}</select></div>
    <div class="field"><label for="bk-avail">Patient is home</label><select class="input" id="bk-avail" data-keep>${Object.entries(META.avail).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div></div>
    <div class="field"><label for="bk-from">Earliest date</label><input class="input" type="date" id="bk-from" data-keep min="${(calDay(0) || {}).iso || ""}" max="${(calDay(S.cal.bookAheadDays) || {}).iso || ""}" value="${esc((B.results && B.results.from ? (calDay(B.results.from) || {}).iso : "") || "")}"><div class="muted" style="font-size:12.5px;margin-top:4px">Leave as today for the soonest gaps, or pick a later date, up to ${S.cal.bookAheadDays >= 60 ? Math.round(S.cal.bookAheadDays / 30.4) + " months" : S.cal.bookAheadDays + " days"} ahead.</div></div>
    ${B.results && B.results.recallLine ? `<div class="callout apricot" style="margin-bottom:12px">${icon("shield")}<div><b>NHS sight test not before ${esc(B.results.recallLine.label)}</b><div style="margin-top:2px">That's their recall line (${B.results.recallLine.months}-month recall, less a month), so these times start from then.</div></div></div>` : ""}
    <div class="field"><label for="bk-src">How they came to us</label><select class="input" id="bk-src" data-keep><option value="">Work it out (recall list, Facebook lead, referral, seen before or new)</option>${Object.entries(META.sources || {}).map(([k, v]) => `<option value="${k}">${esc(v.label)} · true count ${v.count}</option>`).join("")}</select></div>
    <label class="chk" style="margin:0 0 12px"><input type="checkbox" id="bk-early" data-keep ${B.early ? "checked" : ""}><span>Early retest: their sight has changed <span class="muted">(allows an NHS test before the recall line; the GOS form needs the reason)</span></span></label>
    <details class="icb" ${B.icb ? "open" : ""}><summary>Short-notice NHS visit approved by the ICB</summary><div class="field" style="margin-top:8px"><label for="bk-icb">Who at the ICB approved it</label><input class="input" id="bk-icb" data-keep maxlength="80" value="${esc(B.icb || "")}" placeholder="Name and role, e.g. Jo Bloggs, primary care contracts"><span class="hint after">PCSE needs 48 hours' notice of an NHS sight test at home (3 weeks for 3 or more at one address). Inside that, only with the ICB's approval: their name goes on the notification. Leave empty otherwise.</span></div></details>
    <button class="btn block lg" type="submit">${icon("pin")}Find the best slots</button>
    ${results}
  </form>`;
}
function wlDrawer() {
  const busy = new Set(S.waitlist.filter((w) => w.status !== "booked").map((w) => w.patientId).concat(S.appts.filter(active).map((a) => a.patientId)));
  const opts = S.patients.filter((p) => !busy.has(p.id));
  return `<div class="drawer-h"><div><div class="caps">Waiting list</div><h2 style="margin-top:6px">Add a patient</h2></div>${closeX}</div>
  <form class="drawer-b" id="wl-form" novalidate>
    <div class="field"><label for="wl-p">Patient</label><select class="input" id="wl-p" data-keep>${opts.map((p) => `<option value="${p.id}">${esc(p.name)} · ${esc(p.pc)}</option>`).join("")}<option value="new">New patient…</option></select></div>
    <div id="wl-new" ${opts.length ? "hidden" : ""}><div class="row2"><div class="field"><label for="wl-name">Name</label><input class="input" id="wl-name" data-keep placeholder="e.g. Ruth Ingham"></div></div>
      <div class="field">${DomiAreas.picker(S.areas || [], "wl-pc", DomiAreas.read(document, "wl-pc"))}</div>
      <div class="row2"><div class="field"><label for="wl-addr">Address</label><input class="input" id="wl-addr" data-keep placeholder="House and street"></div><div class="field"><label for="wl-phone">Mobile</label><input class="input" id="wl-phone" data-keep placeholder="07700 900000" inputmode="tel"></div></div></div>
    <div class="row2"><div class="field"><label for="wl-type">Visit type</label><select class="input" id="wl-type" data-keep>${Object.entries(TYPES_NOW()).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("")}</select></div>
    <div class="field"><label for="wl-prio">Priority</label><select class="input" id="wl-prio" data-keep><option value="routine">Routine</option><option value="soon">Soon</option><option value="urgent">Urgent</option></select></div></div>
    <div class="row2"><div class="field"><label for="wl-avail">Availability</label><select class="input" id="wl-avail" data-keep>${Object.entries(META.avail).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div class="field"><label for="wl-short">Short notice</label><select class="input" id="wl-short" data-keep><option value="1">Can take a same-day visit</option><option value="0">Needs 24h notice</option></select></div></div>
    <button class="btn block lg" type="submit">${icon("plus")}Add to waiting list</button>
  </form>`;
}
/* ---------- Patients: find anyone, open their record, change it, export or erase it ---------- */
const OPEN = ["booked", "enroute", "live"];
const searchText = (p) => [p.name, p.obId || "", p.pc, p.pc.replace(/\s/g, ""), p.addr, p.phone.replace(/\s/g, ""), p.dob || ""].join(" ").toLowerCase();
const clinUsers = () => (S.staff || []).filter((u) => u.role === "clinician");
function patientsDrawer(d) {
  const words = String(d.q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const all = S.patients.filter((p) => !p.erased);
  const list = all.filter((p) => words.every((w) => searchText(p).includes(w))).sort((a, b) => a.name.localeCompare(b.name));
  const next = (p) => S.appts.filter((a) => a.patientId === p.id && OPEN.includes(a.status)).sort((a, b) => a.day - b.day || a.start - b.start)[0];
  const waiting = new Set(S.waitlist.filter((w) => w.status !== "booked").map((w) => w.patientId));
  return `<div class="drawer-h"><div><div class="caps">${all.length} patients</div><h2 style="margin-top:6px">Patients</h2></div>${closeX}</div>
  <div class="drawer-b">
    <div class="field"><label for="pt-q">Find a patient</label><input class="input" id="pt-q" data-keep type="search" placeholder="Name, postcode, phone or date of birth" autocomplete="off" value="${esc(d.q || "")}"></div>
    <ul class="plist-o">${list.slice(0, 80).map((p) => { const a = next(p); return `<li><button type="button" data-act="open-rec" data-id="${p.id}">
      <span><b>${esc(p.name)}</b><span class="muted">${esc(p.addr)}, ${esc(p.pc)}</span></span>
      <span class="tags">${a ? `<span class="badge b-forest">${a.day ? esc(dayName(a.day).slice(0, 3)) + " " : "Today "}${hm(a.start)}</span>` : ""}${waiting.has(p.id) ? `<span class="badge b-apricot">Waiting</span>` : ""}${p.contact === "Call" ? `<span class="badge b-plain">${icon("phone")}Phone</span>` : ""}</span></button></li>`; }).join("")}</ul>
    ${list.length > 80 ? `<p class="muted" style="font-size:13px">Showing 80 of ${list.length}. Type more of the name to narrow it down.</p>` : ""}
    ${!list.length ? `<div class="empty"><b>Nobody matches</b>Try a surname, a postcode like BL1, or the last digits of a phone number.</div>` : ""}
  </div>`;
}
async function openRecord(id) { const d = { kind: "patient", id, rec: null }; openDrawer(d); d.rec = await api("GET", "/api/patients/" + id); if (UI.drawer === d) redraw(); }
const dobText = (p) => p.dob ? `${new Date(p.dob + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}${p.age ? ` (${p.age})` : ""}` : p.age ? `Age ${p.age}` : "Not recorded";
function patientDrawer(d) {
  const p = d.rec;
  if (!p) return `<div class="drawer-h"><div><div class="caps">Patient record</div><h2 style="margin-top:6px">Opening…</h2></div>${closeX}</div>`;
  if (d.edit) return patientForm(p);
  if (p.erased) return `<div class="drawer-h"><div><div class="caps">Patient record</div><h2 style="margin-top:6px">Erased patient</h2></div>${closeX}</div><div class="drawer-b"><p class="muted">This patient's personal details were erased on request. The anonymous visit history is kept so the diaries and reports still add up.</p></div>`;
  const visits = S.appts.filter((a) => a.patientId === p.id && OPEN.includes(a.status)).sort((a, b) => a.day - b.day || a.start - b.start);
  const waits = S.waitlist.filter((w) => w.patientId === p.id && w.status !== "booked");
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  return `<div class="drawer-h"><div><div class="caps">Patient record</div><h2 style="margin-top:6px">${esc(p.name)}</h2>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${p.contact === "Call" ? `<span class="badge b-plain">${icon("phone")}Phone, don't text</span>` : `<span class="badge b-plain">${icon("msg")}Texts</span>`}${waits.length ? `<span class="badge b-apricot">On the waiting list</span>` : ""}</div></div>${closeX}</div>
    <div class="drawer-b">
      <dl class="kv">${row("Address", `${esc(p.addr)}, ${esc(p.pc)}`)}${row("Phone", `<span class="mono">${esc(p.phone || "None")}</span>`)}${p.email ? row("Email", esc(p.email)) : ""}${row("Date of birth", esc(dobText(p)))}
        ${row("Home visit because", p.eligibility ? esc(p.eligibility) : `<span class="late">Not recorded: the NHS claim needs it</span>`)}${row("Next of kin", esc(p.rep || "None recorded"))}${row("Glasses", esc(p.specs))}${p.alerts.length ? row("Visit notes", esc(p.alerts.join(". "))) : ""}</dl>
      <button class="btn secondary sm" style="margin-top:14px" type="button" data-act="rec-edit">${icon("note")}Edit details</button>
      <div class="hr" style="margin:20px 0 14px"></div>
      <div class="caps">Booked visits</div>
      ${visits.length ? `<div class="offers">${visits.map((a) => { const c = cln(a.clinicianId), t = T(a.type); return `<div class="offer"><div class="oh"><span><b class="mono">${a.day ? esc(dayName(a.day)) : "Today"} · ${hm(a.start)}</b><div class="muted" style="font-size:12.5px">${t.name} with ${esc(c ? c.name : "")}</div></span>${a.status !== "booked" ? `<span class="badge b-warn">${a.status === "live" ? "With patient" : "On the way"}</span>` : ""}</div>
        ${a.status === "booked" ? `<div class="oa"><button class="btn secondary sm" type="button" data-act="cancel-link" data-id="${a.id}">${icon("copy")}Family cancel link</button><button class="btn secondary sm" type="button" data-act="open-appt" data-id="${a.id}">${icon("x")}Cancel</button><button class="btn sm" type="button" data-act="move" data-id="${a.id}">${icon("cal")}Move</button></div>` : ""}</div>`; }).join("")}</div>`
        : `<p class="muted" style="margin:8px 0 0;font-size:13.5px">No visits booked.</p>`}
      <button class="btn sm" style="margin-top:12px" type="button" data-act="book-for" data-id="${p.id}">${icon("plus")}Book a visit</button>
      ${waits.length ? `<div class="hr" style="margin:20px 0 14px"></div><div class="caps">Waiting for</div><ul class="mini">${waits.map((w) => `<li>${T(w.type).name} · ${esc(META.prio[w.prio].label)} priority${w.note ? ` · ${esc(w.note)}` : ""}</li>`).join("")}</ul>` : ""}
      <div class="hr" style="margin:20px 0 14px"></div>
      <div class="caps">History</div>
      ${p.history && p.history.length ? `<ul class="mini">${p.history.slice(0, 8).map((n) => `<li><b>${esc(n.label)}</b>${n.by ? ` · ${esc(n.by)}` : ""}<div>${esc(n.body)}</div></li>`).join("")}</ul>` : `<p class="muted" style="font-size:13.5px">Nothing yet.</p>`}
      <details class="gdpr"><summary>${icon("shield")}Their data (UK GDPR)</summary>
        <p class="muted">If ${esc(first(p.name))} or someone acting for them asks what you hold, download everything and send it to them.</p>
        <button class="btn secondary sm" type="button" data-act="rec-export">${icon("copy")}Download everything we hold</button>
        <p class="muted" style="margin-top:16px">Erasing removes their details for good. It isn't possible while a visit is booked, or for anyone already seen: clinical and NHS claim records must be kept for at least 7 years.</p>
        <div class="field"><label for="erase-name">Type ${esc(p.name)} to confirm</label><input class="input" id="erase-name" data-keep autocomplete="off"></div>
        <button class="btn danger sm" type="button" data-act="rec-erase">Erase their details</button>
      </details>
    </div>`;
}
function patientForm(p) {
  const f = (id, label, v, extra = "") => `<div class="field"><label for="pe-${id}">${label}</label><input class="input" id="pe-${id}" value="${esc(v || "")}" ${extra}></div>`;
  return `<div class="drawer-h"><div><div class="caps">Edit details</div><h2 style="margin-top:6px">${esc(p.name)}</h2></div>${closeX}</div>
  <form class="drawer-b" id="pe-form">
    <div class="row2">${f("name", "Full name", p.name, 'maxlength="80" required')}${f("dob", "Date of birth", p.dob, 'type="date" min="1900-01-01" max="2026-10-12"')}</div>
    ${f("addr", "First line of the address", p.addr, 'maxlength="120" required')}
    <div class="field">${DomiAreas.picker(S.areas || [], "pe-pc", p.pc)}</div>
    <div class="row2">${f("phone", "Phone", p.phone, 'inputmode="tel" required')}
      <div class="field"><label for="pe-contact">How to reach them</label><select class="input" id="pe-contact"><option value="Text" ${p.contact === "Text" ? "selected" : ""}>Text (needs a mobile)</option><option value="Call" ${p.contact === "Call" ? "selected" : ""}>Phone, don't text</option></select></div></div>
    ${f("email", "Email", p.email, 'type="email" maxlength="120"')}
    ${f("elig", "Why they need a home visit", p.eligibility, 'maxlength="200" placeholder="The condition, e.g. Dementia, not just housebound"')}
    ${f("rep", "Next of kin or carer, and their number", p.rep, 'maxlength="120"')}
    ${f("poa", "Power of attorney (health and welfare), and their number", p.poa, 'maxlength="120"')}
    <div class="field"><label for="pe-share">May we talk to their next of kin or carer about visits?</label><select class="input" id="pe-share"><option value="" ${!p.share ? "selected" : ""}>Not asked yet</option><option value="yes" ${p.share === "yes" ? "selected" : ""}>Yes</option><option value="no" ${p.share === "no" ? "selected" : ""}>No: only the patient</option></select></div>
    ${f("specs", "Glasses", p.specs, 'maxlength="80"')}
    <div class="row2">${f("ob", "Opticabase ID", p.obId, 'maxlength="20" inputmode="numeric" placeholder="e.g. 25220"')}${f("next", "Next exam (from Opticabase)", p.nextExam, 'type="date"')}</div>
    ${nhsFields("pe", p)}
    <div class="row2">${f("last", "Last sight test", p.lastTest, `type="date" min="1990-01-01" max="${(calDay(0) || {}).iso || ""}"`)}<div class="field"><label for="pe-recall">Recall (set by the optometrist)</label><select class="input" id="pe-recall">${[[12, "12 months"], [6, "6 months"], [3, "3 months"], [24, "24 months"]].map(([m, l]) => `<option value="${m}" ${(p.recallMonths || 12) === m ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>
    <div class="field"><label for="pe-alerts">Notes for the clinician, one per line</label><textarea class="input" id="pe-alerts" rows="3" maxlength="1000" placeholder="Key safe by the back door">${esc(p.alerts.join("\n"))}</textarea></div>
    <div class="drawer-f" style="margin:8px -22px -22px"><button class="btn ghost" type="button" data-act="rec-edit-cancel">Cancel</button><button class="btn" type="submit">${icon("check")}Save changes</button></div>
  </form>`;
}

/* ---------- Moving a visit to another time ---------- */
function moveDrawer(d) {
  const a = S.appts.find((x) => x.id === d.id); if (!a) return "";
  const p = pat(a.patientId), c = cln(a.clinicianId), o = d.data;
  const slots = !o ? `<p class="muted">Finding times…</p>` : o.slots.length
    ? `<div class="offers">${o.slots.map((x, i) => { const k = cln(x.clinicianId); return `<div class="offer ${i === 0 ? "accepted" : ""}"><div class="oh"><span style="display:flex;gap:10px;align-items:center"><span class="avatar sm" style="background:${k.color}">${initials(k.name)}</span><span><b class="mono">${x.day === 0 ? "Today" : esc(dayName(x.day))} · ${esc(x.label)}</b><div class="muted" style="font-size:12.5px">${esc(k.name)}</div></span></span>${i === 0 ? `<span class="badge b-ok">Best fit</span>` : `<span class="badge b-plain">+${x.extraDrive} min</span>`}</div>
      <div class="why">${x.why.map((w) => `<span>${esc(w)}</span>`).join("")}</div>
      <div class="oa"><button class="btn sm" type="button" data-act="move-to" data-c="${x.clinicianId}" data-d="${x.day}" data-s="${x.start}">${icon("check")}Move to ${x.day === 0 ? "" : esc(dayName(x.day).slice(0, 3)) + " "}${esc(x.label.slice(0, 5))}</button></div></div>`; }).join("")}</div>`
    : `<div class="callout apricot">${icon("clock")}<div><b>No other time fits${o.searchFrom ? " from " + esc(o.fromLabel) : ""}</b><div style="margin-top:2px">Cancel the visit and add ${esc(first(p.name))} to the waiting list instead.</div></div></div>`;
  return `<div class="drawer-h"><div><div class="caps">Move a visit</div><h2 style="margin-top:6px">${esc(p.name)}</h2></div>${closeX}</div>
    <div class="drawer-b">
      <p class="muted" style="margin:0 0 14px;font-size:13.5px">Now ${a.day ? esc(dayName(a.day)) : "today"} at ${hm(a.start)} with ${esc(c.name)} (${T(a.type).name.toLowerCase()}). ${p.contact === "Call" ? `${esc(first(p.name))} asked to be phoned, so ring them with the new time.` : `${esc(first(p.name))} gets one text with the new time.`}${T(a.type).pvn ? " The PCSE notification moves with it, and an NHS sight test only goes 48 hours or more ahead." : ""}</p>
      <form class="row2" id="move-from" style="align-items:end;margin-bottom:14px"><div class="field" style="margin:0"><label for="mv-from">Search from</label><input class="input" type="date" id="mv-from" min="${(calDay(0) || {}).iso || ""}" max="${(calDay(S.cal.bookAheadDays) || {}).iso || ""}" value="${o && o.searchFrom ? esc((calDay(o.searchFrom) || {}).iso || "") : ""}"></div><button class="btn secondary" type="submit">${icon("search")}Search</button>
        ${T(a.type).pvn ? `<details class="icb" style="grid-column:1/-1" ${d.icb ? "open" : ""}><summary>Short-notice move approved by the ICB</summary><div class="field" style="margin-top:8px"><label for="mv-icb">Who at the ICB approved it</label><input class="input" id="mv-icb" maxlength="80" value="${esc(d.icb || "")}" placeholder="Name and role"><span class="hint after">Only for a move inside PCSE's notice period, or of a visit already notified less than 48 working hours away. Search again after filling it in.</span></div></details>` : ""}</form>
      ${slots}
    </div>`;
}

/* ---------- A free slot: who could take it, and booking whoever the office rings ---------- */
/** Phone mode: a cancellation opens the slot's call list straight away (unless the office is busy in another drawer). */
async function openCallList(slotId) {
  if (UI.drawer && UI.drawer.kind !== "gap" && UI.drawer.kind !== "flow" && UI.drawer.kind !== "appt") { toast("A visit was cancelled: its call list is under Free slots"); return; }
  const d = { kind: "gap", id: slotId, data: null }; openDrawer(d);
  d.data = await api("GET", `/api/gaps/${slotId}`).catch(() => null); if (UI.drawer === d) redraw();
}
function gapDrawer(d) {
  const g = d.data;
  if (!g) return `<div class="drawer-h"><div><div class="caps">Free slot</div><h2 style="margin-top:6px">Finding who fits…</h2></div>${closeX}</div>`;
  const phoneMode = g.mode === "phone";
  const ok = g.candidates.filter((x) => x.ok), rest = g.candidates.filter((x) => !x.ok).slice(0, 6);
  const nhsBlocked = rest.some((x) => /PCSE/.test(x.reason || ""));
  const card = (x, i) => { const p = pat(x.patientId); const ring = phoneMode || x.byPhone; const tel = String(p.phone || "").replace(/[^\d+]/g, "");
    return `<div class="offer ${phoneMode && i === 0 ? "accepted" : ""}"><div class="oh"><span><b>${phoneMode ? `${i + 1}. ` : ""}${esc(x.name)}</b> <span class="muted">· ${T(x.type).name}</span></span>${phoneMode && i === 0 ? `<span class="badge b-ok">Best match: ring first</span>` : x.byPhone && !phoneMode ? `<span class="badge b-apricot">${icon("phone")}Phone them</span>` : `<span class="badge b-plain">${x.score} pts</span>`}</div>
    ${ring && p.phone ? `<a class="cl-tel" href="tel:${esc(tel)}">${icon("phone")}<span class="mono">${esc(p.phone)}</span>${p.rep ? `<span class="muted">· family: ${esc(p.rep)}</span>` : ""}</a>` : ""}
    <div class="why">${x.why.map((w) => `<span>${esc(w)}</span>`).join("")}</div>
    <div class="oa cl-acts">
      <button class="btn sm" type="button" data-act="gap-book" data-slot="${g.slotId}" data-w="${x.waitlistId}">${icon("check")}${ring ? "They said yes: book" : "Book " + esc(first(x.name))}</button>
      ${phoneMode ? `<button class="btn ghost sm" type="button" data-act="gap-skip" data-slot="${g.slotId}" data-w="${x.waitlistId}" data-v="no-answer">No answer</button><button class="btn ghost sm" type="button" data-act="gap-skip" data-slot="${g.slotId}" data-w="${x.waitlistId}" data-v="declined">Not interested</button>` : ""}</div></div>`; };
  const intro = phoneMode
    ? `${g.window} min free. Ring down the list, best match first. When someone says yes, book them here: ${esc(first(g.clinician))}'s phone updates straight away. No answer or not interested takes them off the list for this slot only.`
    : `${g.window} min free. Ring anyone below and book them here: they're texted the time (unless they asked for calls), ${esc(first(g.clinician))}'s phone updates, and anyone with an offer out hears it's gone.${g.offeredTo.length ? ` Waiting on a text reply from ${esc(g.offeredTo.join(" and "))}.` : ""}`;
  return `<div class="drawer-h"><div><div class="caps">${esc(g.clinician)} · ${whenLabel(g.day, g.start)}</div><h2 style="margin-top:6px">${phoneMode ? "Call list for this slot" : "Fill this slot"}</h2></div>${closeX}</div>
    <div class="drawer-b">
      <p class="muted" style="margin:0 0 14px;font-size:13.5px">${intro}</p>
      ${nhsBlocked ? `<div class="callout" style="margin-bottom:12px">${icon("shield")}<div><b>No NHS sight test in this slot</b><div style="margin-top:2px">It's inside PCSE's notice period, so the list only has visits that don't need a notification: repairs, deliveries, rechecks and private tests.</div></div></div>` : ""}
      ${ok.length ? `<div class="offers">${ok.slice(0, 8).map(card).join("")}</div>` : `<div class="callout apricot">${icon("clock")}<div><b>${g.rung && g.rung.length ? "Everyone who fits has been rung" : "Nobody on the waiting list fits"}</b><div style="margin-top:2px">Use Book a visit to put in someone new, or leave the time free.</div></div></div>`}
      ${g.rung && g.rung.length ? `<div class="rung"><span class="caps">Rung for this slot</span>${g.rung.map((r) => `<span>${esc(r.name)}: ${esc(r.outcome)}</span>`).join("")}</div>` : ""}
      ${rest.length ? `<details style="margin-top:16px" ${phoneMode && !ok.length ? "open" : ""}><summary class="muted">Who can't take it, and why</summary><ul class="mini">${rest.map((x) => `<li><b>${esc(x.name)}</b><div>${esc(x.reason)}</div></li>`).join("")}</ul></details>` : ""}
    </div>`;
}

/* ---------- The team: clinicians, office accounts, working hours ---------- */
/** The practice's opening hours, from Settings: the diary shows them and clinicians' hours fit inside them. */
const dayS = () => (S && S.settings && S.settings.dayStart != null ? S.settings.dayStart : META.dayStart);
const dayE = () => (S && S.settings && S.settings.dayEnd != null ? S.settings.dayEnd : META.dayEnd);
const quarters = (from = dayS(), to = dayE()) => { const q = []; for (let m = from; m <= to; m += 15) q.push(m); return q; };
const hoursText = (h) => WD().map((d, i) => h[i] ? (h[i][0] === dayS() && h[i][1] === dayE() ? null : `${d.slice(0, 3)} ${hm(h[i][0])}–${hm(h[i][1])}`) : `${d.slice(0, 3)} off`).filter(Boolean).join(" · ") || `Mon–Fri, ${hm(dayS())}–${hm(dayE())}`;
function teamDrawer(d) {
  const t = d.data;
  if (!t) return `<div class="drawer-h"><div><div class="caps">The practice</div><h2 style="margin-top:6px">Team</h2></div>${closeX}</div><div class="drawer-b"><p class="muted">Loading…</p></div>`;
  if (d.edit) return d.edit.kind === "clin" ? clinicianForm(t, d.edit.id) : staffForm(t, d.edit.id);
  const person = (x, kind) => `<li class="${x.active ? "" : "off"}"><span class="avatar sm" style="background:${x.color || "#5B6770"}">${initials(x.name)}</span>
    <span class="who"><b>${esc(x.name)}</b>${x.active ? "" : ` <span class="badge b-plain">Switched off</span>`}<span class="muted">${kind === "clin" ? `${esc(x.role)} · ${esc(x.areaName)}` : esc(x.title || "Office")}${x.email ? ` · ${esc(x.email)}` : ""}</span>${kind === "clin" ? `<span class="muted">${esc(hoursText(x.hours))}</span>` : ""}</span>
    <span class="acts">${x.active ? `<button class="btn secondary sm" type="button" data-act="tm-edit" data-k="${kind}" data-id="${x.id}">Edit</button>` : ""}<button class="btn ghost sm" type="button" data-act="tm-active" data-k="${kind}" data-id="${x.id}" data-v="${x.active ? 0 : 1}">${x.active ? "Switch off" : "Switch on"}</button></span></li>`;
  return `<div class="drawer-h"><div><div class="caps">The practice</div><h2 style="margin-top:6px">Team</h2></div>${closeX}</div>
    <div class="drawer-b">
      <div class="panel-h" style="padding:0 0 8px"><h3 class="caps" style="margin:0">Clinicians</h3><button class="btn sm" type="button" data-act="tm-edit" data-k="clin">${icon("plus")}Add a clinician</button></div>
      <ul class="team">${t.clinicians.map((c) => person(c, "clin")).join("")}</ul>
      <div class="panel-h" style="padding:18px 0 8px"><h3 class="caps" style="margin:0">Office</h3><button class="btn sm" type="button" data-act="tm-edit" data-k="staff">${icon("plus")}Add an office account</button></div>
      <ul class="team">${t.staff.map((u) => person(u, "staff")).join("")}</ul>
      <div class="callout plain" style="margin-top:18px">${icon("shield")}<div>Everyone signs in with a password and a code from an authenticator app. Switching someone off signs them out on every device at once; their history stays.<div class="muted" style="margin-top:4px">New people are emailed a link to set up their own password and authenticator app.</div></div></div>
    </div>`;
}
function clinicianForm(t, id) {
  const c = t.clinicians.find((x) => x.id === id) || { name: "", role: "Optometrist", color: "#0089CF", areaName: "", patch: [], near: [], base: "", email: "", hours: WD().map(() => [dayS(), dayE()]) };
  const opts = (sel) => quarters().map((m) => `<option value="${m}" ${m === sel ? "selected" : ""}>${hm(m)}</option>`).join("");
  const f = (k, label, v, extra = "") => `<div class="field"><label for="tm-${k}">${label}</label><input class="input" id="tm-${k}" value="${esc(v || "")}" ${extra}></div>`;
  return `<div class="drawer-h"><div><div class="caps">${id ? "Edit clinician" : "New clinician"}</div><h2 style="margin-top:6px">${esc(c.name || "Add a clinician")}</h2></div>${closeX}</div>
  <form class="drawer-b" id="tm-clin" data-id="${esc(id || "")}">
    <div class="row2">${f("name", "Full name", c.name, 'maxlength="60" required')}<div class="field"><label for="tm-role">Role</label><select class="input" id="tm-role">${t.roles.map((r) => `<option ${r === c.role ? "selected" : ""}>${r}</option>`).join("")}</select></div></div>
    <div class="row2">${f("email", "Signs in with (email)", c.email, 'type="email" required')}<div class="field"><label for="tm-color">Colour in the diary</label><input class="input" id="tm-color" type="color" value="${esc(c.color)}" style="height:44px;padding:4px"></div></div>
    ${f("area", "Area name", c.areaName, 'maxlength="60" placeholder="e.g. Bolton & Bury"')}
    <div class="row2">${f("patch", "Postcode areas they cover", c.patch.join(", "), 'placeholder="BL1, BL2, BL3"')}${f("near", "Will also go to", c.near.join(", "), 'placeholder="BL4, M8"')}</div>
    ${f("base", "Starts the day from (postcode)", c.base, 'placeholder="BL1 5DN"')}
    <div class="caps" style="margin:8px 0 8px">Working hours</div>
    <div class="hours">${WD().map((d, i) => { const h = c.hours[i]; return `<div class="hrow"><label class="chk"><input type="checkbox" id="tm-w${i}" ${h ? "checked" : ""}> ${esc(d.slice(0, 3))}</label>
      <select class="input" id="tm-s${i}" aria-label="${esc(d)} start">${opts(h ? h[0] : dayS())}</select><span class="muted">to</span><select class="input" id="tm-e${i}" aria-label="${esc(d)} finish">${opts(h ? h[1] : dayE())}</select></div>`; }).join("")}</div>
    <p class="muted" style="font-size:12.5px;margin:8px 0 0">Untick a day for a day off. Bookings, refills and route planning stay inside these hours. If booked visits fall outside new hours, Domi says which, so they can be moved first.</p>
    <div class="drawer-f" style="margin:16px -22px -22px"><button class="btn ghost" type="button" data-act="tm-back">Back</button><button class="btn" type="submit">${icon("check")}${id ? "Save" : "Add and create their sign-in"}</button></div>
  </form>`;
}
function staffForm(t, id) {
  const u = t.staff.find((x) => x.id === id) || { name: "", title: "", email: "" };
  return `<div class="drawer-h"><div><div class="caps">${id ? "Edit office account" : "New office account"}</div><h2 style="margin-top:6px">${esc(u.name || "Add an office account")}</h2></div>${closeX}</div>
  <form class="drawer-b" id="tm-staff" data-id="${esc(id || "")}">
    <div class="field"><label for="ts-name">Full name</label><input class="input" id="ts-name" value="${esc(u.name)}" maxlength="60" required></div>
    <div class="field"><label for="ts-title">Job title</label><input class="input" id="ts-title" value="${esc(u.title || "")}" maxlength="60" placeholder="Receptionist"></div>
    <div class="field"><label for="ts-email">Signs in with (email)</label><input class="input" id="ts-email" type="email" value="${esc(u.email)}" required></div>
    <p class="muted" style="font-size:12.5px">Office accounts see every patient and every round, so give one only to people who run the diary.</p>
    <div class="drawer-f" style="margin:16px -22px -22px"><button class="btn ghost" type="button" data-act="tm-back">Back</button><button class="btn" type="submit">${icon("check")}${id ? "Save" : "Add"}</button></div>
  </form>`;
}
const download = (name, text, type) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
/* ---------- Invoices ---------- */
function invoicesDrawer(d) {
  const st = S.settings, P = st.prices || {};
  const badge = (i) => i.status === "paid" ? `<span class="badge b-ok">Paid · ${esc(i.method)}</span>` : i.status === "void" ? `<span class="badge b-plain">Void</span>` : `<span class="badge b-warn">Unpaid</span>`;
  return `<div class="drawer-h"><div><div class="caps">Raised when a visit is completed</div><h2 style="margin-top:6px">Invoices</h2></div>${closeX}</div>
    <div class="drawer-b">
      <div class="rp-tiles">${`<div class="rp-tile"><b>${pounds(d.totals.unpaidPence)}</b><span>unpaid</span></div><div class="rp-tile"><b>${pounds(d.totals.paidPence)}</b><span>paid</span></div>`}</div>
      <div class="soon-row">${soon("card", "Take card payment", "check")}${soon("xero", "Sync to Xero", "reset")}${soon("carehome", "Bill a care home", "users")}</div>
      <details class="prices"><summary>Prices per visit type</summary>
        <div class="price-grid">${Object.entries(TYPES_NOW()).map(([k, t]) => `<label><span>${esc(t.name)}</span><span class="price-in">£<input type="number" min="0" max="5000" step="5" data-price="${k}" value="${P[k] ?? 0}" aria-label="Price for ${esc(t.name)} in pounds"></span></label>`).join("")}</div>
        <p class="muted" style="font-size:12.5px;margin:8px 0 0">£0 means no invoice is raised: NHS sight tests are claimed on a GOS 6, and glasses are charged when ordered. No VAT is added: check your VAT treatment with your accountant.</p></details>
      ${d.invoices.length ? `<ul class="invs">${d.invoices.map((i) => { const p = pat(i.patientId); return `<li>
        <div style="min-width:0"><div class="nm"><span class="mono">${esc(i.number)}</span> · ${esc(p ? p.name : "")}</div><div class="meta">${esc(i.items.map((x) => x.desc).join(", "))}</div></div>
        <div class="ia"><b>${pounds(i.totalPence)}</b>${badge(i)}</div>
        <div class="ib">${i.status === "unpaid" ? `<select data-paymethod="${i.id}" aria-label="Payment method"><option value="card">Card</option><option value="cash">Cash</option><option value="bank">Bank transfer</option></select>
          <button class="btn sm" type="button" data-act="inv-pay" data-id="${i.id}">${icon("check")}Mark paid</button><button class="btn secondary sm" type="button" data-act="inv-void" data-id="${i.id}">Void</button>` : ""}
          <button class="btn secondary sm" type="button" data-act="inv-print" data-id="${i.id}">Print</button></div></li>`; }).join("")}</ul>`
        : `<div class="empty"><b>No invoices yet</b>Complete a visit on a clinician's phone and its invoice appears here.</div>`}
    </div>`;
}
async function printInvoice(id) {
  const i = await api("GET", "/api/invoices/" + id);
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(i.number)}</title>
    <style>body{font:15px/1.5 system-ui,sans-serif;color:#1b2a25;max-width:640px;margin:40px auto;padding:0 24px}h1{font-size:28px;margin:0}table{width:100%;border-collapse:collapse;margin:24px 0}td,th{text-align:left;padding:8px 0;border-bottom:1px solid #ddd}td:last-child,th:last-child{text-align:right}.muted{color:#667}.paid{color:#1E4D40;font-weight:700}@media print{button{display:none}}</style></head>
    <body><div style="display:flex;justify-content:space-between;gap:24px"><div><h1>Invoice</h1><div class="muted">${esc(i.number)} · issued ${esc(i.issuedAt.slice(0, 5))}, ${esc(dayName(i.issuedDay))}</div></div>
    <div style="text-align:right"><b>${esc(i.practice.name)}</b><br><span class="muted">${[i.practice.addr, i.practice.phone, i.practice.email].filter(Boolean).map(esc).join("<br>")}</span></div></div>
    <p style="margin-top:28px"><b>To</b><br>${esc(i.patient.name)}<br>${esc(i.patient.addr)}, ${esc(i.patient.pc)}</p>
    <table><thead><tr><th>Description</th><th>Amount</th></tr></thead><tbody>${i.items.map((x) => `<tr><td>${esc(x.desc)}</td><td>${pounds(x.pence)}</td></tr>`).join("")}</tbody>
    <tfoot><tr><th>Total</th><th>${pounds(i.totalPence)}</th></tr></tfoot></table>
    <p class="${i.status === "paid" ? "paid" : ""}">${i.status === "paid" ? `Paid by ${esc(i.method)} at ${esc(String(i.paidAt).slice(0, 5))}. Thank you.` : i.status === "void" ? "This invoice has been voided." : "Payment due on receipt."}</p>
    <p class="muted" style="font-size:12px">Sample invoice from a demo practice.</p><button onclick="print()">Print or save as PDF</button></body></html>`;
  const w = window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank");
  if (!w) toast("Allow pop-ups to print invoices", true);
}

/* ---------- Mileage and utilisation ---------- */
const pounds = (p) => "£" + (p / 100).toFixed(2);
function reportDrawer(r) {
  const P = r.practice;
  const tile = (v, l) => `<div class="rp-tile"><b>${v}</b><span>${l}</span></div>`;
  return `<div class="drawer-h"><div><div class="caps">This week</div><h2 style="margin-top:6px">Mileage &amp; utilisation</h2></div>${closeX}</div>
    <div class="drawer-b">
      <div class="rp-tiles">${tile(P.miles + " mi", "driven (est.)")}${tile(pounds(P.mileagePence), `mileage at ${r.ratePence}p/mile`)}${tile(P.utilisation + "%", "of working time booked")}${tile(P.roadShare + "%", "of working time on the road")}</div>
      ${r.clinicians.map((c) => `<section class="rp-c">
        <div class="rp-h"><span class="avatar sm" style="background:${c.color}">${initials(c.name)}</span><b>${esc(c.name)}</b><span class="muted">${c.total.visits} visits · ${c.total.miles} mi · ${pounds(c.total.mileagePence)}</span></div>
        <table class="rp-t"><thead><tr><th>Day</th><th>Visits</th><th>Booked</th><th>Driving</th><th>Miles</th></tr></thead><tbody>
        ${c.days.map((d) => `<tr><td>${esc(d.day === 0 ? "Today" : d.dayLabel.slice(0, 3))}</td><td>${d.visits}</td><td><div class="rp-bar"><i style="width:${Math.min(100, d.utilisation)}%"></i></div><span class="mono">${d.utilisation}%</span></td><td class="mono">${d.driveMin ? mins(d.driveMin) : "–"}</td><td class="mono">${d.miles || "–"}</td></tr>`).join("")}
        </tbody></table></section>`).join("")}
      <button class="btn secondary block" type="button" data-act="report-csv">${icon("copy")}Download CSV for mileage claims</button>
      <p class="muted" style="font-size:12.5px;margin-top:12px">Booked time is against each clinician's working hours. Miles are estimated from distance between postcodes, including the drive from and back to each clinician's base. ${r.ratePence}p a mile is HMRC's approved rate for cars, for the first 10,000 business miles a year.</p>
    </div>`;
}
function reportCsv(r) {
  const rows = [["Clinician", "Day", "Visits", "Booked minutes", "Working minutes", "Utilisation %", "Driving minutes", "Miles (estimated)", `Mileage at ${r.ratePence}p (GBP)`]];
  r.clinicians.forEach((c) => c.days.forEach((d) => rows.push([c.name, d.dayLabel, d.visits, d.bookedMin, d.workingMin, d.utilisation, d.driveMin, d.miles, (d.mileagePence / 100).toFixed(2)])));
  const csv = rows.map((row) => row.map((v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "mileage-and-utilisation.csv";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/** The practice's own booking page, for its website, recall texts and leaflets. */
function bookLinkModal() {
  const refer = !!(UI.drawer && UI.drawer.refer), url = `${location.origin}/${refer ? "refer" : "book"}/${S.sandbox}`;
  let qr = "";
  try { const q = qrcode(0, "M"); q.addData(url); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch (e) { qr = ""; }
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><div><div class="caps">For patients${refer ? ", family and carers" : ""}</div><h2 style="margin-top:6px;font-size:30px">${refer ? "Referral form" : "Patient booking page"}</h2></div>${closeX}</div>
    <p class="muted" style="margin:8px 0 0">${refer ? "Link it from your website's Book or Contact page instead of a callback form. Patients, family, carers, care homes and GPs fill it in, and it arrives here under New referrals: no emails, documents or spreadsheets to retype."
      : "Patients pick a time themselves. It only offers times from tomorrow that add 20 minutes of driving or less, and never shows other patients' details. Glasses deliveries stay with the office."}</p>
    ${qr ? `<div class="qr">${qr}</div>` : ""}
    <div class="copyline"><span class="mono">${esc(url)}</span><button class="btn secondary sm" type="button" data-act="copy" data-v="${esc(url)}">${icon("copy")}Copy</button></div>
    <p style="text-align:center;margin:12px 0 0"><a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener">Open it</a></p>`;
}
function qrModal() {
  const as = UI.qrAs || "u-c1";
  const p = UI.pair && UI.pair.as === as && Date.now() < UI.pair.until ? UI.pair : null;
  if (!p) newPairLink(as);
  let qr = "";
  if (p) { try { const q = qrcode(0, "M"); q.addData(p.url); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch (e) { qr = ""; } }
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><div><div class="caps">This demo</div><h2 style="margin-top:6px;font-size:30px">Open on your phone</h2></div>${closeX}</div>
    <p class="muted" style="margin:8px 0 0">Scan with your phone's camera. It signs the phone in to this same demo, so changes here appear there instantly.</p>
    <div class="field" style="margin-top:16px"><label for="qr-as">Sign the phone in as</label><select class="input" id="qr-as">${clinUsers().map((u) => `<option value="${u.id}" ${u.id === as ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></div>
    ${p ? (qr ? `<div class="qr">${qr}</div>` : `<p class="err">The QR code couldn't load. Sign in on the phone with the code below instead.</p>`) : `<div class="qr wait">${icon("spin")}</div>`}
    <p class="muted" style="text-align:center;font-size:12.5px;margin:4px 0 0">${icon("shield")} Demo shortcut: a one-time link that works once, for 10 minutes. <button class="linkish" type="button" data-act="new-pair">New link</button></p>
    <div class="code">${esc(S.sandbox)}</div>
    <p class="muted" style="text-align:center;font-size:13px;margin:6px 0 0">Or open <span class="mono">${esc(location.host)}</span> on the phone, sign in, and enter this demo code.</p>`;
}
let pairing = false;
async function newPairLink(as) {
  if (pairing) return;
  pairing = true;
  try {
    const r = await api("POST", "/api/auth/pair", { userId: as });
    UI.pair = { as, url: `${location.origin}/?pair=${encodeURIComponent(r.token)}`, until: Date.now() + (r.expiresIn - 30) * 1000 };
  } catch (e) { fail(e); UI.pair = null; }
  finally { pairing = false; }
  if (UI.drawer && UI.drawer.kind === "qr") redraw();
}

/* ============ Ticking clock ============ */
function tick() {
  if (!S) return;
  const n = demoNow();
  document.querySelectorAll("[data-clock]").forEach((e) => { e.textContent = hm(n); });
  const y = Math.max(0, Math.min((dayE() - dayS()) * 1.4, (n - dayS()) * 1.4));
  document.querySelectorAll("[data-now]").forEach((e) => { e.style.top = y + "px"; });
}
setInterval(() => { tick(); if (UI.drawer && UI.drawer.kind === "flow" && UI.flow && !UI.flow.outcome) redraw(); }, 15000);

/* ============ Actions ============ */
async function openPatient(id, apptId) {
  try { UI.rec = await api("GET", "/api/patients/" + id); }
  catch (e) {
    const saved = e.offline && (store.get(OFFLINE_KEY, {}).records || {})[id];
    if (!saved) throw e.offline ? new Error("This record isn't saved on the phone. It will open when you have signal.") : e;
    UI.rec = saved; goOffline();
  }
  UI.pid = id;
  const a = S.appts.find((x) => x.id === apptId);
  if (a && a.moved && !a.seen) { a.seen = true; api("POST", "/api/appointments/" + a.id + "/seen").catch(() => {}); }
  render();
  const sc = $("#ph-scroll"); if (sc) sc.scrollTop = 0; window.scrollTo(0, 0);
}
async function switchRole(admin) {
  if (!S || isAdmin() === admin) return;
  closeDrawer();
  if (!admin && S.signedInAs.dual && !UI.pickedClin) UI.lastClin = S.signedInAs.id; // a director's own round first
  await viewAs(admin ? S.signedInAs.id : UI.lastClin, admin);
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act;
  try {
    switch (act) {
      case "pick-user": {
        const pw = META.demo ? META.demo.password : "";
        $("#email").value = el.dataset.email;
        if (!pw) { $("#password").focus(); break; }
        $("#password").value = pw;
        el.disabled = true;
        try { await submitPassword(el.dataset.email, pw, ($("#join-code") || {}).value || ""); } finally { el.disabled = false; }
        break;
      }
      case "demo-code": {
        const r = await api("GET", "/api/auth/demo-code?challenge=" + encodeURIComponent(UI.auth.challenge));
        if (!r.code) { toast("The next code isn't ready yet. Try again in a few seconds.", true); break; }
        $("#code").value = r.code; $("#code").focus();
        toast(`Filled in. This code changes in ${r.secondsLeft} seconds.`);
        break;
      }
      case "auth-back": UI.auth = { step: "password" }; render(); break;
      case "new-pair": UI.pair = null; redraw(); break;
      case "close": closeDrawer(); break;
      case "pcse-done": el.disabled = true; await api("POST", `/api/pcse/${el.dataset.id}/done`); await load(); toast("Ticked off"); break;
      case "recall-text": el.disabled = true; await api("POST", `/api/recalls/${el.dataset.id}/text`); await load(); toast("Booking link texted"); break;
      case "recall-dismiss": await api("POST", `/api/recalls/${el.dataset.id}/dismiss`); await load(); toast("Removed from recalls and the refill pool"); break;
      case "soon": openDrawer({ kind: "soon", id: el.dataset.id }); break;
      case "roadmap": { const v = el.dataset.v; if (UI.drawer) closeDrawer(); go("coming-soon"); if (v) setTimeout(() => { const c = $("#rm-" + v); if (c) { c.scrollIntoView({ block: "center" }); c.classList.add("hl"); } }, 300); break; }
      case "invoices": openDrawer({ kind: "invoices", data: await api("GET", "/api/invoices") }); break;
      case "inv-pay": { const m = document.querySelector(`[data-paymethod="${el.dataset.id}"]`).value; await api("POST", `/api/invoices/${el.dataset.id}/pay`, { method: m }); panel("invoices").data = await api("GET", "/api/invoices"); redraw(); toast("Marked as paid"); break; }
      case "inv-void": await api("POST", `/api/invoices/${el.dataset.id}/void`); panel("invoices").data = await api("GET", "/api/invoices"); redraw(); toast("Invoice voided"); break;
      case "inv-print": await printInvoice(el.dataset.id); break;
      case "report": openDrawer({ kind: "report", data: await api("GET", "/api/reports/week") }); break;
      case "report-csv": reportCsv(panel("report").data); toast("CSV downloaded"); break;
      case "booklink": openDrawer({ kind: "booklink" }); break;
      case "referlink": openDrawer({ kind: "booklink", refer: true }); break;
      case "referral": openDrawer({ kind: "referral", id: el.dataset.id }); break;
      case "lead": go("leads/" + el.dataset.id); break;
      case "tray": {
        UI.tray = el.dataset.v; render();
        if (el.dataset.jump) { const t = $(".tray"); if (t && t.getBoundingClientRect().top < 0 || (t && t.getBoundingClientRect().top > innerHeight - 200)) t.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }
        break;
      }
      case "lead-email": openDrawer({ kind: "lead-email" }); break;
      case "adform": window.open(`/ad-form/${S.sandbox}`, "_blank", "noopener"); break;
      case "lead-status": {
        el.disabled = true;
        await api("POST", `/api/leads/${el.dataset.id}/status`, { status: el.dataset.v, note: ($("#ld-note") || {}).value });
        await load(); if (UI.drawer) closeDrawer(); else render();
        toast(el.dataset.v === "booked" ? "Marked as booked" : el.dataset.v === "closed" ? "Marked as not interested" : "Marked as called");
        break;
      }
      case "lead-hours": {
        el.disabled = true;
        await api("PUT", "/api/settings", { officeHours: ($("#ld-hours") || {}).value });
        await load(); redraw(); toast("Office hours saved. New thank-you emails will use them.");
        break;
      }
      case "ref-accept": {
        el.disabled = true;
        const body = { type: ($("#rf-type") || {}).value, prio: ($("#rf-prio") || {}).value, anyway: el.dataset.anyway === "1" };
        try { const r = await api("POST", `/api/referrals/${el.dataset.id}/accept`, body); await load(); closeDrawer(); toast(`Added to the waiting list${r.texted ? " and texted" : ""}`); }
        catch (e) { if (/already on Domi/.test(e.message)) { UI.drawer.dup = e.message; redraw(); } else throw e; }
        break;
      }
      case "ref-decline": el.disabled = true; await api("POST", `/api/referrals/${el.dataset.id}/decline`, { reason: ($("#rf-why") || {}).value }); await load(); closeDrawer(); toast("Referral declined"); break;
      case "copy": try { await navigator.clipboard.writeText(el.dataset.v); toast("Link copied"); } catch (e) { toast("Couldn't copy. Select the link instead.", true); } break;
      case "route": await openRoute(el.dataset.c, el.dataset.d != null ? Number(el.dataset.d) : UI.view === "week" ? 0 : UI.day); break;
      case "map-focus": focusStop(el.dataset.map, Number(el.dataset.i)); break;
      case "plan-route": el.disabled = true; UI.drawer.plan = await api("GET", `/api/route/plan?clinician=${el.dataset.c}&day=${el.dataset.d}`); redraw(); break;
      case "plan-cancel": UI.drawer.plan = null; redraw(); break;
      case "plan-apply": {
        el.disabled = true;
        const r = await api("POST", "/api/route/plan", { clinicianId: el.dataset.c, day: Number(el.dataset.d) });
        const data = await api("GET", `/api/route?clinician=${el.dataset.c}&day=${el.dataset.d}`);
        UI.drawer = { kind: "route", data, applied: r }; await load(); toast(`Route planned: ${mins(r.savedMin)} less driving`); break;
      }
      case "plans": UI.drawer = { kind: "plans", day: UI.view === "week" ? 1 : UI.day }; openDrawer(UI.drawer); await loadPlans(UI.drawer.day); break;
      case "plans-day": await loadPlans(Number(el.dataset.v)); break;
      case "plans-apply": case "plans-apply-all": {
        el.disabled = true;
        const D = panel("plans"), ids = act === "plans-apply" ? [el.dataset.c] : D.list.filter((p) => p.changed && !p.applied).map((p) => p.clinicianId);
        let saved = 0;
        for (const id of ids) { const r = await api("POST", "/api/route/plan", { clinicianId: id, day: D.day }); saved += r.savedMin; const i = D.list.findIndex((p) => p.clinicianId === id); D.list[i] = { ...r, applied: true, changed: 0 }; }
        await load(); toast(`Routes planned: ${mins(saved)} less driving`); break;
      }
      case "my-route": {
        if (UI.myRoute) { UI.myRoute = null; render(); break; }
        try { UI.myRoute = await api("GET", "/api/route?day=0"); }
        catch (e) { const saved = e.offline && store.get(OFFLINE_KEY, {}).route; if (!saved) throw e; UI.myRoute = saved; }
        render(); break;
      }
      case "slot-map": {
        const B = UI.book, i = Number(el.dataset.i);
        if (B.map && B.map.i === i) { B.map = null; redraw(); break; }
        const x = B.results.slots[i], p = B.results.patient;
        const q = new URLSearchParams({ clinician: x.clinicianId, day: x.day, pc: p.pc, start: x.start, type: B.results.type, name: p.name });
        B.map = { i, data: await api("GET", "/api/route?" + q) }; redraw(); break;
      }
      case "send-reminders": {
        el.disabled = true;
        const r = await api("POST", "/api/reminders/send");
        await load(); toast(`${r.sent} reminder${r.sent === 1 ? "" : "s"} sent for tomorrow. Try replying CANCEL as one of them.`);
        break;
      }
      case "mode": await api("PUT", "/api/settings", { mode: el.dataset.v }); await load(); break;
      case "open-appt": openDrawer({ kind: "appt", id: el.dataset.id }); break;
      /* The office runs everything: records, visits, gaps, the team */
      case "patients": go("patients"); break;
      case "open-rec": go("patients/" + el.dataset.id); break;
      case "go": go(el.dataset.v); break;
      case "pf": UI.pf = el.dataset.v; UI.plimit = PAGE; render(); break;
      case "lt": UI.lt = el.dataset.v; render(); break;
      case "nd-open": UI.nd = el.dataset.id; render(); { const f = $("#nd-form"); if (f) f.scrollIntoView({ block: "center", behavior: "smooth" }); } break;
      case "nd-close": UI.nd = null; render(); break;
      case "lead-patient": { const l = (S.leads || []).find((x) => x.id === el.dataset.id); UI.npPre = l ? { name: l.name, phone: l.phone, email: l.email, pc: l.pc, dob: l.dob || "", addr: l.addr ? l.addr.replace(/,?\s*[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\s*$/i, "").split(",")[0].trim() : "", leadId: l.id } : null; go("patients/new"); break; }
      case "fb-key": { if (!confirm("Make a new private link? The old one stops working straight away, so update it in Zapier or Make.")) break; UI.pg.conn = await api("POST", "/api/leads/connection/key"); render(); toast("New link made. Paste it into Zapier or Make."); break; }
      case "fb-disconnect": { if (!confirm("Disconnect Facebook? New leads will stop arriving directly until you connect again.")) break; UI.pg.conn = await api("PUT", "/api/leads/connection/meta", { disconnect: true }); render(); toast("Facebook disconnected"); break; }
      case "pmore": UI.plimit = (UI.plimit || PAGE) + PAGE; render(); break;
      case "rec-edit": { const d = ctx("patient"); d.edit = true; rerender(d); break; }
      case "rec-edit-cancel": { const d = ctx("patient"); d.edit = false; rerender(d); break; }
      case "rec-export": {
        const d = ctx("patient"), data = await api("GET", `/api/patients/${d.id}/export`);
        download(`${d.rec.name.replace(/[^A-Za-z]+/g, "-").toLowerCase()}-records.json`, JSON.stringify(data, null, 2), "application/json");
        toast("Downloaded. Send it securely, never by ordinary email."); break;
      }
      case "rec-erase": {
        const d = ctx("patient"), v = ($("#erase-name") || {}).value || "";
        el.disabled = true;
        await api("POST", `/api/patients/${d.id}/erase`, { confirm: v });
        if (UI.drawer) closeDrawer(); else UI.pg = null;
        await load(); toast("Their details have been erased"); break;
      }
      case "book-for": UI.book = { patientId: el.dataset.id }; openDrawer({ kind: "book" }); break;
      case "move": { const d = { kind: "move", id: el.dataset.id, data: null }; openDrawer(d); d.data = await api("POST", `/api/appointments/${el.dataset.id}/move-options`, {}); if (UI.drawer === d) redraw(); break; }
      case "move-to": {
        el.disabled = true;
        const r = await api("POST", `/api/appointments/${UI.drawer.id}/move`, { clinicianId: el.dataset.c, day: Number(el.dataset.d), start: Number(el.dataset.s), icb: UI.drawer.icb || undefined });
        closeDrawer(); UI.view = "day"; UI.day = r.day; await load();
        toast(`${r.patient} moved to ${r.day ? r.dayLabel + " " : "today "}${r.label.slice(0, 5)} with ${first(r.clinician)}${r.texted ? ". They've been texted." : ". Ring them with the new time."}`); break;
      }
      case "cancel-link": {
        const { url } = await api("POST", `/api/appointments/${el.dataset.id}/cancel-link`);
        if (!url) { toast("The link isn't ready yet. Reload the page and try again.", true); break; }
        try { await navigator.clipboard.writeText(url); toast("Cancellation link copied. Send it to the family: it cancels this visit only."); } catch (err) { window.prompt("Copy the cancellation link:", url); }
        break;
      }
      case "record": {
        el.disabled = true;
        const r = await api("POST", `/api/appointments/${el.dataset.id}/record`, { outcome: el.dataset.v, note: ($("#rec-note") || {}).value || "", rebook: !!($("#rec-rebook") || {}).checked });
        closeDrawer(); await load();
        toast(r.status === "done" ? (r.invoice ? `Recorded as completed. Invoice ${r.invoice.number} raised.` : "Recorded as completed") : r.rebooked ? "Recorded: nobody in. Back on the waiting list." : "Recorded: nobody in"); break;
      }
      case "gap": { const d = { kind: "gap", id: el.dataset.id, data: null }; openDrawer(d); d.data = await api("GET", `/api/gaps/${el.dataset.id}`); if (UI.drawer === d) redraw(); break; }
      case "gap-skip": {
        el.disabled = true;
        await api("POST", `/api/gaps/${el.dataset.slot}/skip`, { waitlistId: el.dataset.w, outcome: el.dataset.v });
        const d = UI.drawer; if (d && d.kind === "gap") { d.data = await api("GET", `/api/gaps/${el.dataset.slot}`); redraw(); }
        toast(el.dataset.v === "no-answer" ? "No answer: next on the list" : "Not interested: next on the list"); break;
      }
      case "gap-book": {
        el.disabled = true;
        const r = await api("POST", `/api/gaps/${el.dataset.slot}/book`, { waitlistId: el.dataset.w });
        closeDrawer(); await load(); toast(`${r.patient} booked for ${r.day ? dayName(r.day) + " " : ""}${hm(r.start)} with ${first(r.clinician)}`); break;
      }
      case "team": go("team"); break;
      case "tm-edit": go(`team/${el.dataset.k}/${el.dataset.id || "new"}`); break;
      case "tm-back": go("team"); break;
      case "calls-stage": UI.pg.stage = Number(el.dataset.v); render(); break;
      case "pvn-tab": UI.pg.tab = el.dataset.v; render(); break;
      case "pilot-edit": UI.pg.edit = true; render(); break;
      case "diary-tab": UI.pg.tab = el.dataset.v; render(); break;
      case "diary-copied": case "diary-copied-all": {
        el.disabled = true;
        const ids = el.dataset.act === "diary-copied" ? [Number(el.dataset.id)] : UI.pg.data.todo.map((r) => r.id);
        const r = await api("POST", "/api/diary-changes/copied", { ids });
        UI.pg.data = await api("GET", "/api/diary-changes"); await load(); toast(`${r.copied} ticked off`); break;
      }
      case "diary-csv": {
        const blob = new Blob(["\ufeff" + diaryCsv(UI.pg.data.todo)], { type: "text/csv" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `domi-diary-changes-${(calDay(0) || {}).iso || "today"}.csv`; document.body.appendChild(a); a.click(); a.remove();
        toast("Downloaded. Tick them off once they're in Opticabase."); break;
      }
      case "pilot-cancel": UI.pg.edit = false; render(); break;
      case "pvn-copy": { const v = el.dataset.v; try { await navigator.clipboard.writeText(v); toast(el.dataset.all ? "Copied: every field for this visit" : "Copied: " + v); } catch (err) { window.prompt("Copy:", v); } break; }
      case "pvn-cancel-done": el.disabled = true; await api("POST", `/api/pcse/${el.dataset.id}/done`); UI.pg.data = await api("GET", "/api/pvn"); await load(); toast("Ticked off: cancelled in PCSE"); break;
      case "call-rec": {
        el.disabled = true;
        await api("POST", `/api/calls/${el.dataset.id}`, { stage: Number(el.dataset.s), outcome: el.dataset.v });
        UI.pg.data = await api("GET", "/api/calls"); await load(); render();
        toast(el.dataset.v === "done" ? "Ticked off" : el.dataset.v === "texted" ? "Sent as a text" : "No answer: it stays on the list");
        break;
      }
      case "tm-invite": {
        if (el.dataset.reset && !confirm("Reset their sign-in? Their password and authenticator codes stop working now, they're signed out everywhere, and they get a link to set up new ones.")) break;
        el.disabled = true;
        const r = await api("POST", `/api/team/users/${el.dataset.id}/invite`);
        const d = ctx("team"); d.invite = r; d.data = await api("GET", "/api/team"); rerender(d);
        toast(r.kind === "reset" ? "Sign-in reset. Their old password and codes no longer work." : "New link sent. The old one no longer works.");
        break;
      }
      case "copy-invite": { const i = $("#invite-url"); try { await navigator.clipboard.writeText(i.value); toast("Link copied. Send it only to them."); } catch (err) { i.select(); toast("Select the link and copy it", true); } break; }
      case "tm-active": {
        const on = el.dataset.v === "1", url = el.dataset.k === "clin" ? `/api/team/clinicians/${el.dataset.id}/active` : `/api/team/staff/${el.dataset.id}/active`;
        if (!on && !confirm("Switch this account off? They'll be signed out on every device.")) break;
        el.disabled = true;
        await api("POST", url, { active: on });
        const d = ctx("team"); d.data = await api("GET", "/api/team"); await load(); rerender(d); toast(on ? "Switched back on" : "Switched off and signed out everywhere"); break;
      }
      case "do-cancel": {
        el.disabled = true;
        const r = await api("POST", "/api/appointments/" + el.dataset.id + "/cancel", { reason: $("#reason").value });
        if (!isAdmin()) { closeDrawer(); UI.pid = null; UI.rec = null; toast("Visit cancelled. The office system is refilling the slot."); await load(); break; }
        if (r.outcome === "call-list") { await openCallList(r.slotId); refetch(); break; }
        UI.flow = flowFrom(r); openDrawer({ kind: "flow" }); refetch(); break;
      }
      case "patient-cancel": el.disabled = true; closeDrawer(); await api("POST", "/api/demo/sms", { patientId: el.dataset.id, body: "CANCEL" }); break;
      case "reply": el.disabled = true; await api("POST", "/api/demo/sms", { patientId: el.dataset.p, body: el.dataset.v }); break;
      case "see-clin": UI.lastClin = "u-" + el.dataset.c; closeDrawer(); await viewAs(UI.lastClin); window.scrollTo(0, 0); break;
      case "add-wl": openDrawer({ kind: "wl" }); break;
      case "book": UI.book = {}; openDrawer({ kind: "book" }); break;
      case "import": UI.imp = {}; openDrawer({ kind: "import" }); break;
      case "import-again": UI.imp = {}; redraw(); break;
      case "imp-filter": UI.imp.filter = el.dataset.v; redraw(); break;
      case "import-template": { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([IMPORT_TEMPLATE], { type: "text/csv" })); a.download = "domi-patients-template.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); break; }
      case "import-commit": {
        const I = UI.imp; I.busy = true; I.err = null; redraw();
        try { I.done = await api("POST", "/api/import/commit", { csv: I.csv, mapping: I.pv.mapping }); I.csv = null; I.pv = null; await load(); toast([I.done.imported && `${I.done.imported} added`, I.done.updated && `${I.done.updated} updated`].filter(Boolean).join(", ") || "Nothing changed"); }
        catch (e) { I.err = e.message; }
        I.busy = false; redraw(); break;
      }
      case "day": UI.view = "day"; UI.day = Number(el.dataset.v); UI.wk = weekStart(UI.day); render(); break;
      case "wk": UI.wk = Math.max(weekStart(-14), Math.min(weekStart(S.cal.bookAheadDays), (UI.wk == null ? weekStart(UI.day) : UI.wk) + Number(el.dataset.v))); { const x = calDay(UI.wk); if (UI.view === "day") UI.day = openAhead(Math.max(UI.wk, -14), 1)[0] ?? UI.wk; void x; } render(); break;
      case "clo-add": {
        const date = $("#clo-date").value, reason = $("#clo-why").value.trim();
        if (!date) { toast("Choose a date first", true); break; }
        const x = calDay(dayByIso(date));
        if (x && !x.open) { toast(`${x.long} is already closed (${x.why})`, true); break; }
        UI.pg.clo = (UI.pg.clo || []).filter((c) => c.date !== date).concat([{ date, reason }]); render(); break;
      }
      case "clo-del": UI.pg.clo = (UI.pg.clo || []).filter((c) => c.date !== el.dataset.v); render(); break;
      case "wk-today": UI.wk = weekStart(0); UI.day = 0; render(); break;
      case "week": UI.view = "week"; render(); break;
      case "book-again": UI.book = {}; redraw(); break;
      case "book-slot": {
        el.disabled = true;
        const r = await api("POST", "/api/bookings", Object.assign(bookInput(), { clinicianId: el.dataset.c, day: Number(el.dataset.d), start: Number(el.dataset.s) }));
        UI.book = { done: r }; UI.view = "day"; UI.day = r.day || 0; redraw(); toast(`${r.patient} booked: ${r.day ? r.dayLabel + " " : ""}${r.label.slice(0, 5)} with ${first(r.clinician)}`); await load(); break;
      }
      case "book-waitlist": {
        const b = bookInput();
        await api("POST", "/api/waitlist", { patientId: b.patientId, name: b.name, pc: b.pc, addr: b.addr, phone: b.phone, type: b.type, prio: "routine", avail: b.avail, shortNotice: true });
        closeDrawer(); await load(); toast("Added to the waiting list"); break;
      }
      case "tab": UI.tab = el.dataset.v; UI.pid = null; UI.rec = null; render(); break;
      case "open-p": await openPatient(el.dataset.id, el.dataset.appt); break;
      case "back": UI.pid = null; UI.rec = null; render(); break;
      case "chip": { const n = $(`#note-${UI.pid}`); n.value = (n.value ? n.value.replace(/[\s.]*$/, "") + ". " : "") + el.textContent; n.focus(); break; }
      case "focus-note": { const n = $(`#note-${UI.pid}`); n.scrollIntoView({ behavior: "smooth", block: "center" }); n.focus({ preventScroll: true }); break; }
      case "save-note": {
        const n = $(`#note-${el.dataset.id}`), v = n.value.trim();
        if (!v) { toast("Write a note first", true); n.focus(); break; }
        const url = "/api/patients/" + el.dataset.id + "/notes";
        if (UI.offline) { n.value = ""; queueChange(url, { body: v }, () => UI.rec.history.unshift({ label: "Saved offline " + hm(demoNow()), body: v, by: S.user.name })); toast("Saved on the phone. It goes to the record when you have signal."); break; }
        try { await api("POST", url, { body: v }); }
        catch (e) { if (!e.offline || !keepsOffline()) throw e; goOffline(); n.value = ""; queueChange(url, { body: v }, () => UI.rec.history.unshift({ label: "Saved offline " + hm(demoNow()), body: v, by: S.user.name })); toast("Saved on the phone. It goes to the record when you have signal."); break; }
        n.value = ""; await load(); toast("Saved to " + UI.rec.name + "'s record"); break;
      }
      case "copy": { const v = el.dataset.v; try { await navigator.clipboard.writeText(v); toast("Number copied: " + v); } catch (err) { toast(v); } break; }
      case "status": {
        const v = el.dataset.v, id = el.dataset.id, n = UI.pid ? $(`#note-${UI.pid}`) : null, note = n ? n.value.trim() : "";
        const offline = () => {
          if (v === "done" && note) { queueChange("/api/patients/" + UI.pid + "/notes", { body: note }, () => UI.rec.history.unshift({ label: "Saved offline " + hm(demoNow()), body: note, by: S.user.name })); n.value = ""; }
          queueChange("/api/appointments/" + id + "/status", { status: v }, () => { const a = S.appts.find((x) => x.id === id); if (a) a.status = v; });
          toast(v === "enroute" ? "Saved. The patient will be texted when you have signal." : v === "live" ? "Visit started (saved on the phone)" : "Visit complete (saved on the phone). It syncs when you have signal.");
          if (v === "done") { UI.pid = null; UI.rec = null; render(); }
        };
        if (UI.offline) { offline(); break; }
        let res;
        try {
          if (v === "done" && note) { await api("POST", "/api/patients/" + UI.pid + "/notes", { body: note }); n.value = ""; }
          res = await api("POST", "/api/appointments/" + id + "/status", { status: v });
        } catch (e) { if (!e.offline || !keepsOffline()) throw e; goOffline(); offline(); break; }
        toast(v === "enroute" ? "Patient texted that you're on the way" : v === "live" ? "Visit started"
          : res.invoice ? `Visit complete. Invoice ${res.invoice.number} raised (${pounds(res.invoice.totalPence)}).` : "Visit complete. On to the next one.");
        if (v === "done") { UI.pid = null; UI.rec = null; }
        await load(); break;
      }
    }
  } catch (err) { fail(err); el.disabled = false; }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (e.target.id === "pilot-form") {
      const v = (id) => ($("#" + id) || {}).value || "";
      const keys = Object.keys(UI.pg.data.measures), baseline = {}, targets = [];
      for (const k of keys) { baseline[k] = v("pl-b-" + k); if (($("#pl-t-" + k) || {}).checked) targets.push({ key: k, pct: v("pl-p-" + k) }); }
      try { UI.pg.data = await api("PUT", "/api/pilot", { start: v("pl-start"), agreedBy: v("pl-by"), baseline, targets }); UI.pg.edit = false; render(); toast("Pilot saved"); }
      catch (x) { if (x.offline) throw x; $("#pl-err").innerHTML = `<div class="callout danger-card" role="alert">${esc(x.message)}</div>`; }
      return;
    }
    if (e.target.dataset.form === "pvn-lodge" || e.target.dataset.form === "pvn-icb") {
      const ids = e.target.dataset.ids.split(",").filter(Boolean), val = (e.target.querySelector("input").value || "").trim();
      if (e.target.dataset.form === "pvn-lodge") { await api("POST", "/api/pvn/lodge", { apptIds: ids, ref: val }); toast(`Lodged: PVN ${val}`); }
      else { for (const id of ids) await api("PUT", `/api/appointments/${id}/pvn`, { icb: val }); toast(val ? `ICB approval saved: ${val}` : "ICB approval removed"); }
      if (e.target.dataset.form === "pvn-lodge") e.target.querySelector("input").value = "";
      UI.pg.data = await api("GET", "/api/pvn"); await load(); return;
    }
    if (e.target.id === "move-from") {
      const d = UI.drawer; if (!d || d.kind !== "move") return;
      const date = $("#mv-from").value; d.icb = (($("#mv-icb") || {}).value || "").trim(); d.data = null; redraw();
      d.data = await api("POST", `/api/appointments/${d.id}/move-options`, { date: date || undefined, icb: d.icb || undefined }); if (UI.drawer === d) redraw();
      return;
    }
    if (e.target.id === "book-form") {
      const b = bookInput(); UI.book = Object.assign(UI.book || {}, { patientId: b.patientId });
      UI.book.results = await api("POST", "/api/slots", b); UI.book.map = null; redraw();
      const best = document.querySelector("#book-form .offer"); if (best) best.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    if (e.target.id === "pg-note") {
      const d = UI.pg, t = $("#pg-note-t"); if (!d || !t.value.trim()) return;
      await api("POST", `/api/patients/${d.id}/notes`, { body: t.value }); t.value = "";
      d.rec = await api("GET", `/api/patients/${d.id}?background=1`); await load(); toast("Note added"); return;
    }
    if (e.target.id === "nd-form") {
      const id = e.target.dataset.id, reason = (e.target.querySelector("[name=nd-reason]:checked") || {}).value;
      const r = await api("POST", `/api/appointments/${id}/not-done`, { reason, rebook: $("#nd-rebook").checked, note: $("#nd-note").value });
      UI.nd = null; await load(); render();
      toast(`${r.reason}: the office can see it${r.rebooked ? ", and they're back on the waiting list" : ""}`);
      return;
    }
    if (e.target.id === "fb-meta") {
      const v = (id) => ($("#set-" + id) || {}).value || "";
      const r = await api("PUT", "/api/leads/connection/meta", { pageId: v("pageId"), appSecret: v("appSecret") || undefined, pageToken: v("pageToken") || undefined });
      UI.pg.conn = r; render(); toast(r.changed.length ? `Saved: ${r.changed.join(", ")}` : "Nothing changed");
      return;
    }
    if (e.target.id && e.target.id.startsWith("set-")) {
      const v = (id) => ($("#set-" + id) || {}).value;
      const body = {
        "set-practice": () => ({ practice: v("practice"), phone: v("phone"), email: v("email"), officeHours: v("hoursText"), logo: v("logo") }),
        "set-hours": () => ({ dayStart: Number(v("ds")), dayEnd: Number(v("de")), bookAheadDays: Number(v("ba")), onlineAheadDays: Number(v("oa")), offerAheadDays: Number(v("fa")), closures: (UI.pg && UI.pg.clo) || S.settings.closures || [] }),
        "set-visits": () => ({ clinicTarget: Number(v("tgt")), durations: Object.fromEntries([...e.target.querySelectorAll("[data-dur]")].map((i) => [i.dataset.dur, Number(i.value)])), prices: Object.fromEntries([...e.target.querySelectorAll("[data-price]")].map((i) => [i.dataset.price, Number(i.value)])), online: [...e.target.querySelectorAll("[data-online]:checked")].map((i) => i.dataset.online) }),
        "set-refill": () => ({ mode: (e.target.querySelector("[name=set-mode]:checked") || {}).value, offerMinutes: Number(v("om")), fee: Number(v("fee")), reminders: $("#set-rem").checked, reminderAt: Number(v("ra")), autoRecalls: $("#set-arc").checked, recallAt: Number(v("rat")) }),
      }[e.target.id];
      if (!body) return;
      const r = await api("PUT", "/api/settings", body());
      if (UI.pg) UI.pg.clo = null;
      await load(); render();
      toast(r.changed.length ? `Saved: ${r.changed.join(", ")}` : "Nothing changed");
      return;
    }
    if (e.target.id === "np-form") {
      const v = (id) => ($("#np-" + id) || {}).value || "", err = $("#np-err");
      try {
        const r = await api("POST", "/api/patients", { leadId: ((UI.pg || {}).pre || {}).leadId, name: v("name"), dob: v("dob"), addr: v("addr"), pc: DomiAreas.read(document, "np-pc"), phone: v("phone"), contact: v("contact"), email: v("email"), eligibility: v("elig"), rep: v("rep"), poa: v("poa"), share: v("share"), specs: v("specs"), alerts: v("alerts"), nhsNo: v("nhs"), premises: v("prem"), venue: v("venue"), venueContact: v("vc") });
        UI.pg = null; await load(); go("patients/" + r.patient.id); toast(`${r.patient.name} added. Book their first visit from here.`);
      } catch (x) {
        if (x.offline) throw x;
        err.innerHTML = `<div class="callout danger-card" role="alert">${esc(x.message)}${x.data && x.data.patientId ? ` <a href="#/patients/${esc(x.data.patientId)}">Open their record</a>` : ""}</div>`;
        err.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      return;
    }
    if (e.target.id === "pe-form") {
      const v = (id) => ($("#pe-" + id) || {}).value || "";
      const d = ctx("patient");
      const r = await api("PUT", "/api/patients/" + d.id, { name: v("name"), dob: v("dob"), addr: v("addr"), pc: DomiAreas.read(document, "pe-pc"), phone: v("phone"), contact: v("contact"), email: v("email"), eligibility: v("elig"), rep: v("rep"), poa: v("poa"), share: v("share"), specs: v("specs"), alerts: v("alerts"), lastTest: v("last"), recallMonths: v("recall"), obId: v("ob"), nextExam: v("next"), nhsNo: v("nhs"), premises: v("prem"), venue: v("venue"), venueContact: v("vc") });
      d.edit = false; d.rec = await api("GET", "/api/patients/" + d.id + "?background=1"); await load(); rerender(d);
      toast(r.changed.length ? `Saved: ${r.changed.join(", ")}` : "Nothing changed");
      return;
    }
    if (e.target.id === "tm-clin") {
      const v = (id) => ($("#tm-" + id) || {}).value || "";
      const hours = WD().map((_, i) => ($("#tm-w" + i) || {}).checked ? [Number(v("s" + i)), Number(v("e" + i))] : null);
      const id = e.target.dataset.id || undefined;
      const r = await api("POST", "/api/team/clinicians", { id, office: !!($("#tm-office") || {}).checked, name: v("name"), role: v("role"), email: v("email"), color: v("color"), areaName: v("area"), patch: v("patch"), near: v("near"), base: v("base"), hours });
      await load();
      if (id) { go("team"); toast("Saved"); }
      else { UI.pg.invite = r.invite; go("team/clin/" + r.id); toast(r.invite.emailed ? `Added. ${first(r.name)} has been emailed an invitation.` : `Added. Send ${first(r.name)} their invitation link.`); }
      return;
    }
    if (e.target.id === "tm-staff") {
      const id = e.target.dataset.id || undefined;
      const r = await api("POST", "/api/team/staff", { id, name: $("#ts-name").value, title: $("#ts-title").value, email: $("#ts-email").value });
      await load();
      if (id) { go("team"); toast("Saved"); }
      else { UI.pg.invite = r.invite; go("team/staff/" + r.id); toast(r.invite.emailed ? `Added. ${first(r.name)} has been emailed an invitation.` : `Added. Send ${first(r.name)} their invitation link.`); }
      return;
    }
    if (e.target.id === "wl-form") {
      await api("POST", "/api/waitlist", { patientId: $("#wl-p").value, name: $("#wl-name").value, pc: DomiAreas.read(document, "wl-pc"), addr: $("#wl-addr").value, phone: $("#wl-phone").value, type: $("#wl-type").value, prio: $("#wl-prio").value, avail: $("#wl-avail").value, shortNotice: $("#wl-short").value === "1" });
      closeDrawer(); await load(); toast("Added to the waiting list");
    }
    if (e.target.id === "pw-form") {
      const join = ($("#join-code") || { value: "" }).value.trim();
      if (!META.live && join && join.length !== 6) { toast("Demo codes are 6 characters, shown on the office screen", true); return; }
      const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
      try { await submitPassword($("#email").value.trim(), $("#password").value, join); } finally { btn.disabled = false; }
    }
    if (e.target.id === "code-form") {
      const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
      try { await submitCode($("#code").value); } finally { if (btn.isConnected) btn.disabled = false; }
    }
  } catch (err) { fail(err); }
});
// Chart tooltips: any mark with data-tip shows it beside the pointer (pilot charts).
let tipEl = null;
document.addEventListener("pointerover", (e) => {
  const m = e.target.closest && e.target.closest("[data-tip]");
  if (!m) { if (tipEl) tipEl.hidden = true; return; }
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "pc-tip"; tipEl.setAttribute("role", "status"); document.body.appendChild(tipEl); }
  tipEl.textContent = m.dataset.tip; tipEl.hidden = false;
});
document.addEventListener("pointermove", (e) => { if (tipEl && !tipEl.hidden) { tipEl.style.left = Math.min(e.clientX + 12, innerWidth - tipEl.offsetWidth - 8) + "px"; tipEl.style.top = (e.clientY - 34) + "px"; } });
document.addEventListener("change", async (e) => {
  try {
    if (e.target.id === "wl-p") $("#wl-new").hidden = e.target.value !== "new";
    if (e.target.classList.contains("pl-entry")) {
      const k = e.target.dataset.k;
      await api("PUT", "/api/pilot/week", { week: Number(e.target.dataset.week), [k]: e.target.value.trim() });
      UI.pg.data = await api("GET", "/api/pilot"); render(); toast(k === "miles" ? "Miles saved" : "Office hours saved");
    }
    if (e.target.dataset.actChange === "pvn-ert") {
      await api("PUT", `/api/appointments/${e.target.dataset.id}/pvn`, { ert: e.target.value || null });
      UI.pg.data = await api("GET", "/api/pvn"); render(); toast(e.target.value ? `Early retest code ${e.target.value} saved` : "Early retest code removed");
    }
    if (e.target.id === "ap-src" || e.target.id === "ap-count") {
      const body = e.target.id === "ap-src" ? { source: e.target.value } : { reliability: Number(e.target.value) };
      api("PUT", `/api/appointments/${e.target.dataset.id}/likelihood`, body).then(() => load()).then(() => { toast(e.target.id === "ap-src" ? "Source saved" : "True count saved"); redraw(); }).catch(fail);
    }
    if (e.target.id === "jump-date" && e.target.value) {
      const d = dayByIso(e.target.value);
      if (d == null) { toast("That date is outside the diary", true); return; }
      UI.view = "day"; UI.day = d; UI.wk = weekStart(d); render();
    }
    if (e.target.id === "imp-file" && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 3e6) { UI.imp.err = "That file is over 3 MB. Split it into smaller files."; redraw(); return; }
      UI.imp = { name: file.name, csv: await file.text() };
      await importPreview(null);
    }
    if (e.target.classList.contains("imp-col")) {
      const m = UI.imp.pv.mapping.slice(); m[Number(e.target.dataset.i)] = e.target.value || null;
      UI.imp.openMap = true; await importPreview(m);
    }
    if (e.target.id === "bk-p") { UI.book = { patientId: e.target.value }; $("#bk-new").hidden = e.target.value !== "new"; redraw(); }
    if (["bk-type", "bk-avail"].includes(e.target.id) && UI.book && UI.book.results) { UI.book.results = null; redraw(); }
    if (e.target.id === "set-ds" || e.target.id === "set-de") { $("#hp-wrap").innerHTML = hoursPreview(Number($("#set-ds").value), Number($("#set-de").value)); return; }
    if (e.target.dataset && e.target.dataset.online) { e.target.nextElementSibling.textContent = e.target.checked ? "Yes" : "No"; return; }
    if (e.target.id === "set-logo") { const u = e.target.value.trim(), box = $("#logo-prev"); box.classList.remove("broken"); box.innerHTML = /^https:\/\//.test(u) ? `<img src="${esc(u)}" alt="Logo preview" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('broken')"><span>This address doesn't load an image</span>` : `<span>${u ? "The address must start with https://" : "No logo: your name is shown instead"}</span>`; return; }
    if (e.target.id === "offer-min") { await api("PUT", "/api/settings", { offerMinutes: Number(e.target.value) }); await load(); toast("Normal reply window: " + e.target.value + " min"); }
    if (e.target.id === "practice-name") { const v = e.target.value.trim(); if (v.length < 2) { e.target.value = S.settings.practice; return; } await api("PUT", "/api/settings", { practice: v }); await load(); toast("Texts now signed " + v); }
    if (e.target.id === "fee") { const v = Math.max(0, Math.round(Number(e.target.value) || 0)); await api("PUT", "/api/settings", { fee: v }); await load(); toast("Fee set to " + money(v) + " per visit"); }
    if (e.target.id === "me") { UI.lastClin = e.target.value; UI.pickedClin = true; await viewAs(e.target.value); }
    if (e.target.dataset && e.target.dataset.price) { await api("PUT", "/api/settings", { prices: { [e.target.dataset.price]: Number(e.target.value) } }); await load(); toast("Price saved"); }
    if (e.target.id === "qr-as") { UI.qrAs = e.target.value; UI.pair = null; redraw(); }
  } catch (err) { fail(err); }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "psearch") { UI.q = e.target.value; render(); }
  if (e.target.id === "pt-q" && UI.drawer) { UI.drawer.q = e.target.value; redraw(); }
  if (e.target.id === "pg-q") { UI.pq = e.target.value; UI.plimit = PAGE; render(); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && UI.drawer) closeDrawer(); });
// Keep the screen at a fixed size: Safari ignores user-scalable=no, so stop pinch here (double-tap zoom is off via CSS touch-action).
["gesturestart", "gesturechange", "gestureend"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
$("#role-admin").onclick = () => switchRole(true).catch(fail);
$("#role-clin").onclick = () => switchRole(false).catch(fail);
$("#open-phone").onclick = () => openDrawer({ kind: "qr" });
$("#signout").onclick = async () => {
  if (outbox.length && !confirm(`${outbox.length} change${outbox.length === 1 ? " hasn't" : "s haven't"} synced yet. Sign out and lose ${outbox.length === 1 ? "it" : "them"}?`)) return;
  try { await api("POST", "/api/auth/logout"); } catch (e) {}
  signedOut(); toast("Signed out");
};
$("#reset").onclick = async () => {
  try {
    if (!isAdmin()) await viewAs(S.signedInAs.id, true);
    await api("POST", "/api/admin/reset"); closeDrawer(); UI.pid = null; UI.rec = null; await load(); toast("Demo started again from 10:20");
  } catch (err) { fail(err); }
};

(async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const params = new URLSearchParams(location.search);
  // ?brand=<id> picks a practice's look and is remembered on this device; without it, the server's default
  // brand for this deployment is used (DEFAULT_BRAND, see server/brands.js).
  const wanted = params.has("brand") ? params.get("brand").toLowerCase() : undefined;
  // A link for a different practice starts a fresh demo for it, rather than reopening the last one.
  if (wanted !== undefined && wanted !== prefs.get("domi-brand")) rememberDemo(null);
  if (wanted !== undefined) prefs.set("domi-brand", wanted);
  BRAND_ID = prefs.get("domi-brand");
  try { META = await api("GET", "/api/meta" + (BRAND_ID ? "?brand=" + encodeURIComponent(BRAND_ID) : "")); applyBrand(META.brand); }
  catch (e) { if (e.offline && goOffline()) return; $("#app").innerHTML = `<div class="shell"><div class="err">Can't reach the server. Start it with <span class="mono">npm start</span> and reload.</div></div>`; return; }
  history.replaceState(null, "", "/"); // never leave a one-time link in the address bar or history
  if (params.get("pair")) {
    try { const r = await api("POST", "/api/auth/pair/redeem", { token: params.get("pair") }); rememberDemo(r.sandbox); await enter(); return; } catch (e) { fail(e); }
  }
  if (params.get("join")) UI.auth = { step: "password", join: params.get("join") };
  if (params.get("email")) UI.auth = { ...UI.auth, email: params.get("email").slice(0, 120) }; // from "You're all set" after an invitation
  try {
    if ((await api("GET", "/api/auth/session")).signedIn) {
      await load();
      if (wanted === undefined || S.brand.id === wanted) { connect(); return; }
      await api("POST", "/api/auth/logout").catch(() => {}); rememberDemo(null); S = null; BRAND_ID = wanted;
      META = await api("GET", "/api/meta" + (BRAND_ID ? "?brand=" + encodeURIComponent(BRAND_ID) : "")); applyBrand(META.brand);
    }
  } catch (e) { /* not signed in */ }
  S = null; render();
})();
})();
