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
  if (lock && lock.dataset.brand !== b.id) {
    lock.dataset.brand = b.id;
    lock.setAttribute("aria-label", b.practice);
    lock.innerHTML = b.logo
      ? `<img class="brand-logo" src="${esc(b.logo)}" alt="${esc(b.logoAlt)}" referrerpolicy="no-referrer"><span class="by">Powered by Domi</span>`
      : `<img src="/logo.svg" alt=""><span class="wm"><b>Domi</b><span>EYE CARE AT HOME</span></span>`;
    // If their site can't be reached, show their name rather than a broken image.
    const img = lock.querySelector(".brand-logo");
    if (img) img.addEventListener("error", () => { lock.innerHTML = `<span class="wm"><b>${esc(b.wordmark)}</b><span>${esc(b.tagline.toUpperCase())}</span></span>`; }, { once: true });
  }
  document.title = b.logo ? `${b.practice} · Diary` : "Domi";
}
const UI = { tab: "today", pid: null, rec: null, q: "", drawer: null, flow: null, lastClin: "u-c1", busy: false, day: 0, view: "day", auth: { step: "password" }, pair: null };
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
  if (!res.ok) throw new Error(data.error || "That didn't work. Try again.");
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
const T = (k) => META.types[k];
const isAdmin = () => !!S && S.user.role === "admin";
const pat = (id) => S.patients.find((p) => p.id === id) || { id, name: "Patient", pc: "", addr: "", alerts: [], phone: "" };
const cln = (id) => S.clinicians.find((c) => c.id === id);
const dayAppts = (c, day = 0) => S.appts.filter((a) => a.clinicianId === c && (a.day || 0) === day && active(a)).sort((x, y) => x.start - y.start);
const dayName = (d) => (META.days || [])[d] || "";
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
  if (UI.drawer && UI.drawer.kind === "invoices") UI.drawer.data = await api("GET", "/api/invoices").catch(() => UI.drawer.data);
  if (UI.myRoute && !isAdmin()) UI.myRoute = await api("GET", "/api/route?day=0").catch(() => null);
  if (UI.pid) { try { UI.rec = await api("GET", "/api/patients/" + UI.pid + "?background=1"); } catch (e) { UI.pid = null; UI.rec = null; } }
  const d = UI.drawer;
  if (d && d.kind === "patient" && !d.edit) d.rec = await api("GET", "/api/patients/" + d.id + "?background=1").catch(() => d.rec);
  if (d && d.kind === "team" && !d.edit) d.data = await api("GET", "/api/team").catch(() => d.data);
  render();
  // A form being filled in isn't redrawn by live updates, so nothing typed or picked is lost.
  if (UI.drawer && !UI.drawer.edit) renderDrawer();
}
let refetchT = null;
const refetch = () => { clearTimeout(refetchT); refetchT = setTimeout(() => load().catch(() => {}), 120); };

const EVENTS = ["patient.updated", "appointment.moved", "team.updated", "refill.started", "reminders.sent", "recall.updated", "invoice.updated", "appointment.booked", "appointment.updated", "offer.sent", "offer.declined", "offer.expired", "slot.filled", "slot.unfilled", "sms.received", "note.added", "waitlist.added", "settings.updated", "pcse.updated", "patients.imported", "route.planned", "referral.updated", "reset"];
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
  if (type === "appointment.booked" && e.online) toast(`Booked online by the patient: ${e.patient}, ${dayName(e.day)} ${hm(e.start)} (+${e.extraDrive} min driving)`);
  if (type === "refill.started") {
    if (e.cancelled && e.cancelled.byText) toast(`${e.cancelled.patient} texted to cancel. Refilling ${hm(e.start)}.`);
    if (e.cancelled && e.cancelled.byLink) toast(`${e.cancelled.patient}'s visit was cancelled online. Refilling ${hm(e.start)}.`);
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
  if (UI.drawer && UI.drawer.kind === "flow") renderDrawer();
}

/* ---------- Sign-in: password, then the code from an authenticator app ---------- */
async function enter() {
  clearErrors();
  UI.tab = "today"; UI.pid = null; UI.rec = null; UI.myRoute = null; UI.auth = { step: "password" };
  await load();
  connect();
}
async function submitPassword(email, password, join) {
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
async function viewAs(userId) {
  await api("POST", "/api/auth/view-as", { userId });
  await enter();
}
const isOffice = () => !!S && !!S.signedInAs && S.signedInAs.role === "admin";

/* ============ Render ============ */
function render() {
  const signedIn = !!S;
  $("#clock").hidden = !signedIn; $("#roles").hidden = !signedIn || !isOffice(); $("#actions").hidden = !signedIn;
  $("#reset").hidden = !isOffice();
  document.body.classList.toggle("clin-mode", signedIn && !isAdmin());
  if (!signedIn) { $("#app").innerHTML = signInView(); return; }
  $("#role-admin").setAttribute("aria-pressed", isAdmin());
  $("#role-clin").setAttribute("aria-pressed", !isAdmin());
  $("#open-phone").hidden = !isAdmin();
  paint($("#app"), isAdmin() ? officeView() : clinView());
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
      <div><div class="caps">Monday 12 October</div><h1 style="margin-top:6px">Today across the team</h1>
        <p>${(() => { const n = onBoard(0).filter((c) => (c.hours || [])[0] !== null).length; return n === 1 ? "One clinician" : (["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"][n] || n) + " clinicians"; })()} on the road. Cancel any visit and the best-matched patient from the waiting list is offered the slot straight away.</p>
        <div class="tools"><button class="btn secondary sm" type="button" data-act="patients">${icon("users")}Patients</button><button class="btn secondary sm" type="button" data-act="team">${icon("shield")}Team &amp; hours</button><button class="btn secondary sm" type="button" data-act="booklink">${icon("qr")}Patient booking page</button><button class="btn secondary sm" type="button" data-act="report">${icon("car")}Mileage &amp; utilisation</button><button class="btn secondary sm" type="button" data-act="invoices">${icon("note")}Invoices</button>${soon("stock", "Stock &amp; repairs", "db")}<button class="btn secondary sm" type="button" data-act="plans">${icon("pin")}Plan routes</button><button class="btn secondary sm" type="button" data-act="import">${icon("copy")}Import patients</button><button class="btn secondary sm" type="button" data-act="roadmap">${icon("next")}What's coming</button></div></div>
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
    <div class="grid">
      <section class="panel" aria-label="Diaries">
        <div class="panel-h"><h2>Diaries</h2>
          <div class="seg day-tabs" role="tablist" aria-label="Choose a day">${(META.days || []).map((d, i) => `<button type="button" role="tab" data-act="day" data-v="${i}" aria-pressed="${UI.view === "day" && UI.day === i}">${i === 0 ? "Today" : d.slice(0, 3)}<span class="mono">${S.appts.filter((a) => active(a) && (a.day || 0) === i).length}</span></button>`).join("")}<button type="button" data-act="week" aria-pressed="${UI.view === "week"}">${icon("cal")}Week</button></div>
        </div>
        ${UI.view === "week" ? weekView() : `<div class="panel-h" style="padding-top:0"><span class="sub">${UI.day === 0 ? "Today, " + dayName(0) : dayName(UI.day)}</span>
          <div class="legend"><span><i class="sw" style="background:var(--surface)"></i>Booked</span><span><i class="sw" style="background:var(--warn-soft)"></i>On the way</span><span><i class="sw" style="background:var(--ok-soft)"></i>With patient</span><span><i class="sw" style="background:var(--subtle)"></i>Done</span><span><i class="sw" style="background:var(--apricot-soft)"></i>Moved forward</span><span><i class="sw" style="background:var(--forest-soft)"></i>New booking</span></div>
        </div>
        <div class="board-wrap" data-scroll="board">${board(nowM)}</div>`}
      </section>
      <aside class="rail">
        <section class="panel" aria-label="Waiting list">
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
        </section>
        ${referralsPanel()}
        ${pcsePanel()}
        ${recallsPanel()}
        ${remindersPanel()}
        <section class="panel" aria-label="Texts">
          <div class="panel-h"><h2>Texts</h2><span class="sub">${S.messages.length} today · ${META.smsProvider === "twilio" ? "sending live" : "demo outbox"}</span></div>
          ${S.messages.length ? `<div class="feed" data-scroll="feed">${S.messages.map(smsBubble).join("")}</div>`
            : `<div class="empty"><b>No texts yet</b>Click a booked visit in a diary to cancel it, or to play the patient texting CANCEL.</div>`}
        </section>
      </aside>
    </div></div>`;
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
      <div class="row2"><div class="field"><label for="rf-type">Waiting list for</label><select class="input" id="rf-type">${Object.entries(META.types).map(([k, v]) => `<option value="${k}" ${k === r.need ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></div>
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
    <p class="panel-note">NHS sight tests at home need a notification to PCSE at least 48 hours before the visit. Domi only offers gaps that leave time for one, and lists what to lodge or cancel.</p>
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
    <div class="soon-row" style="padding:0 18px 8px">${soon("recall-auto", "Send recall texts automatically", "send")}</div>
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
/** Clinicians on the diary: everyone working, plus anyone who has left but still has visits that day. */
const onBoard = (day) => S.clinicians.filter((c) => c.active !== false || S.appts.some((a) => a.clinicianId === c.id && (a.day || 0) === day && active(a)));
function board(nowM) {
  const PX = 1.4, DS = META.dayStart, DE = META.dayEnd, H = (DE - DS) * PX;
  const team = onBoard(UI.day);
  let ticks = "";
  for (let m = DS; m <= DE; m += 60) ticks += `<div class="tick mono" style="top:${(m - DS) * PX}px">${hm(m)}</div>`;
  const nowY = Math.max(0, Math.min(H, (nowM - DS) * PX));
  const lanes = team.map((c, ci) => {
    const list = dayAppts(c.id, UI.day);
    // Outside their working hours (or a day off) is shaded, so nobody books into it by eye.
    const h = (c.hours || [])[UI.day] === undefined ? [DS, DE] : c.hours[UI.day];
    const off = !h ? `<div class="off-hours" style="top:0;height:${H}px"><span>Day off</span></div>`
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
        + (a.status === "missed" ? `<span class="badge b-plain" style="margin-top:4px">Nobody in</span>` : "");
      return `${drive}<button class="blk ${cls}" type="button" data-act="open-appt" data-id="${a.id}" style="top:${top}px;height:${h}px" aria-label="${esc(p.name)} at ${hm(a.start)}">${head}${extra}</button>`;
    }).join("");
    const filled = new Set(list.map((a) => a.start));
    const gaps = S.appts.filter((a) => a.clinicianId === c.id && (a.day || 0) === UI.day && a.status === "cancelled" && !filled.has(a.start)).map((a) => {
      const t = T(a.type), offers = S.offers.filter((o) => o.slot_id === a.id);
      const label = offers.length ? `Offer out · replies close ${esc(offers[0].deadline)}` : `Open slot · ${money(S.metrics.fee)} unfilled`;
      return `<button class="blk gap ${offers.length ? "offering" : ""}" type="button" data-act="gap" data-id="${a.id}" style="top:${(a.start - DS) * PX}px;height:${t.dur * PX - 4}px" aria-label="Free slot at ${hm(a.start)}: choose who fills it"><span class="tm">${hm(a.start)}</span><span class="ty">${label}</span></button>`;
    }).join("");
    return `<div class="lane" style="height:${H}px;background-size:100% ${60 * PX}px">${off}${blocks}${gaps}${UI.day === 0 ? `<div class="now" data-now style="top:${nowY}px">${ci === 0 ? `<span class="now-label mono" data-clock>${hm(nowM)}</span>` : ""}</div>` : ""}</div>`;
  }).join("");
  const heads = team.map((c) => `<div class="col-h"><span class="avatar sm" style="background:${c.color}">${initials(c.name)}</span><div style="min-width:0;flex:1"><div class="nm">${esc(c.name)}</div><div class="rl">${esc(c.role)} · ${esc(c.areaName)}</div></div><button class="icon-btn sm" type="button" data-act="route" data-c="${c.id}" title="${esc(c.first)}'s route on a map" aria-label="${esc(c.first)}'s route on a map">${icon("pin")}</button></div>`).join("");
  return `<div class="board" style="grid-template-columns:56px repeat(${team.length},minmax(210px,1fr))"><div class="col-h"></div>${heads}<div class="times" style="height:${H}px">${ticks}</div>${lanes}</div>`;
}

/* Week at a glance: each clinician's load per day; click a day to open it. */
function weekView() {
  const WORK = META.dayEnd - META.dayStart;
  const cells = S.clinicians.filter((c) => c.active !== false).map((c) => `<div class="wk-row"><div class="col-h" style="border:0;padding:0"><span class="avatar sm" style="background:${c.color}">${initials(c.name)}</span><div><div class="nm">${esc(c.first || c.name)}</div><div class="rl">${esc(c.areaName)}</div></div></div>
    ${(META.days || []).map((d, i) => {
      const h = (c.hours || [])[i] === undefined ? [META.dayStart, META.dayEnd] : c.hours[i];
      const list = dayAppts(c.id, i), mins = list.reduce((t, a) => t + T(a.type).dur + (a.drive || 0), 0), pct = h ? Math.min(100, Math.round(mins / (h[1] - h[0]) * 100)) : 0;
      if (!h && !list.length) return `<div class="wk-cell off"><span class="wk-sub">Day off</span></div>`;
      const fresh = list.filter((a) => a.moved || a.bookedMin != null).length;
      return `<button class="wk-cell" type="button" data-act="day" data-v="${i}" aria-label="${esc(c.name)}, ${d}: ${list.length} visits">
        <span class="wk-n">${list.length}<small> visits</small></span>
        <span class="wk-bar"><i style="width:${pct}%"></i></span>
        <span class="wk-sub">${pct}% of the day booked${fresh ? ` · ${fresh} new` : ""}</span></button>`;
    }).join("")}</div>`).join("");
  return `<div class="week" data-scroll="week"><div class="wk-row wk-head"><div></div>${(META.days || []).map((d, i) => `<div class="caps">${i === 0 ? "Today" : d}</div>`).join("")}</div>${cells}</div>`;
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
      <div class="soon-row" style="margin-top:14px">${soon("apps", "iPhone &amp; Android apps", "phone")}</div></div>
    <div class="phone">
      <div class="ph-scroll" id="ph-scroll" data-scroll="phone">${UI.offline ? `<div class="offline-bar" role="status">${icon("bolt")}<span><b>No signal.</b> Your round and records are saved on this phone.${outbox.length ? ` ${outbox.length} change${outbox.length === 1 ? "" : "s"} waiting to sync.` : ""}</span></div>` : ""}${body}</div>
      <nav class="ph-tabs" aria-label="Clinician sections">
        <button type="button" data-act="tab" data-v="today" aria-current="${!UI.pid && UI.tab === "today" ? "page" : "false"}">${icon("cal")}Today</button>
        <button type="button" data-act="tab" data-v="patients" aria-current="${UI.tab === "patients" || UI.pid ? "page" : "false"}">${icon("users")}Patients</button>
        <button type="button" data-act="tab" data-v="msgs" aria-current="${!UI.pid && UI.tab === "msgs" ? "page" : "false"}">${icon("msg")}Messages${unread ? `<span class="dot">${unread}</span>` : ""}</button>
      </nav>
    </div><div></div></div></div>`;
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
  const switcher = !isOffice() ? "" : `<span class="preview-tag">Office preview</span><select class="who-select" id="me" aria-label="Switch clinician">${clinUsers().map((u) => `<option value="${u.id}" ${u.id === "u-" + c.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>`;
  let hero = "";
  if (nxt) {
    const p = pat(nxt.patientId), t = T(nxt.type), act = nextAction(nxt);
    hero = `<div class="next">
      <div class="nt"><span class="caps" style="color:inherit;opacity:.75">${nxt.status === "live" ? "With patient now" : nxt.status === "enroute" ? "On the way" : "Next visit"}</span>${nxt.moved ? `<span class="badge b-apricot">${icon("bolt")}Moved forward</span>` : ""}</div>
      <div class="nt" style="align-items:flex-end"><div><div class="time">${hm(nxt.start)}</div><div class="pn" style="margin-top:6px">${esc(p.name)}</div></div><span class="tag-chip">${t.name}</span></div>
      <div class="ad">${icon("pin")}${esc(p.addr)}, ${esc(p.pc)}</div>
      ${p.alerts.length ? `<div class="ad">${icon("users")}${esc(p.alerts[0])}</div>` : ""}
      <div class="acts">${act ? `<button class="btn light" type="button" data-act="status" data-v="${act.v}" data-id="${nxt.id}">${icon(act.ic)}${act.label}</button>` : ""}<button class="btn outline" type="button" data-act="open-p" data-id="${p.id}" data-appt="${nxt.id}">Record</button></div>
    </div>`;
  }
  const cards = rest.map((a, i) => {
    const p = pat(a.patientId), t = T(a.type);
    const st = a.status === "done" ? `<span class="badge b-plain">Done</span>` : a.status === "missed" ? `<span class="badge b-plain">Nobody in</span>` : a.moved ? `<span class="badge b-apricot">${icon("bolt")}Moved</span>` : a.bookedMin != null ? `<span class="badge b-forest">${icon("plus")}New</span>` : "";
    return `${a.drive && i > 0 && a.status !== "done" ? `<div class="drive-row">${icon("car")}${a.drive} min drive</div>` : ""}
      <button class="v ${a.moved ? "moved" : a.status === "done" ? "done" : ""}" type="button" data-act="open-p" data-id="${p.id}" data-appt="${a.id}">
        <div class="tl"><span class="t">${hm(a.start)}</span><span class="ln"></span></div>
        <div class="card"><div class="row"><span class="type-chip">${t.name}</span>${st}</div>
          <div class="pn">${esc(p.name)}</div>
          <div class="ad">${icon("pin")}<span>${esc(p.addr)}, ${esc(p.pc)}</span></div>
          ${p.alerts.length && a.status !== "done" ? `<div class="ad" style="color:var(--warn)">${icon("users")}<span>${esc(p.alerts[0])}</span></div>` : ""}
        </div></button>`;
  }).join("");
  return `<div class="ph-head"><div><div class="caps">Mon 12 Oct · <span data-clock>${hm(demoNow())}</span></div><h2 style="margin-top:6px">Morning, ${esc(c.first)}</h2></div>${switcher}</div>
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
  const maps = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(p.addr + ", Leeds " + p.pc);
  return `<button class="back" type="button" data-act="back">${icon("back")}Back</button>
    <div class="rec-h"><div class="caps">${a ? `${hm(a.start)} · ${t.name}` : "Patient record"}</div><h2 style="margin-top:6px">${esc(p.name)}</h2>
      <div class="sub">${p.age ? p.age + " years · " : ""}${esc(p.addr)}, ${esc(p.pc)}</div></div>
    <div class="tags"><span class="tag">${icon("msg")}Prefers: ${esc(p.contact)}</span>${p.alerts.map((x) => `<span class="tag alert">${esc(x)}</span>`).join("")}</div>
    <div class="quick">
      <a href="${maps}" target="_blank" rel="noopener">${icon("pin")}Directions</a>
      <button type="button" data-act="copy" data-v="${esc(p.phone)}">${icon("copy")}<span class="mono">${esc(p.phone.slice(-6))}</span></button>
      <button type="button" data-act="focus-note">${icon("note")}Add note</button>
    </div>
    ${a && a.moved ? `<div class="banner">${icon("bolt")}<div><b>Moved forward today</b>${esc(a.note)}</div></div>` : ""}
    ${!a && later ? `<div class="callout forest" style="margin-top:12px">${icon("cal")}<div><b>Next visit: ${esc(dayName(later.day))} at ${hm(later.start)}</b><div style="margin-top:2px">${esc(T(later.type).name)}</div></div></div>` : ""}
    <div class="sec"><h3>Visit notes ${a && a.status === "live" ? `<span class="badge b-ok">In progress</span>` : ""}</h3>
      <div class="chips">${["Vision recorded", "Pressures checked", "Fundus photos taken", "Frames chosen", "GOS 6 signed", "Glasses fitted & adjusted", "Referred to GP", "Recall in 12 months"].map((c) => `<button type="button" data-act="chip">${c}</button>`).join("")}</div>
      <textarea class="note" id="note-${p.id}" data-keep placeholder="What did you do on this visit?"></textarea>
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:10px">${soon("ai-notes", "Draft with AI", "bolt")}<button class="btn sm" type="button" data-act="save-note" data-id="${p.id}">${icon("check")}Save to record</button></div>
    </div>
    <div class="sec"><h3>Prescription</h3>${p.rx ? prescription(p.rx) : `<p class="muted" style="margin:0;font-size:13.5px">No prescription on record yet. It's added after the sight test.</p>`}
      <div class="soon-row" style="margin-top:10px">${soon("pcse-online", "Claim GOS 6", "send")}${soon("images", "Add fundus photos", "copy")}</div></div>
    <div class="sec"><h3>Letters &amp; forms</h3><div class="soon-row">${soon("letters", "GP letter", "note")}${soon("letters", "Pre-visit form", "msg")}</div></div>
    <div class="sec"><h3>Details</h3><dl class="kv"><dt>Phone</dt><dd class="mono">${esc(p.phone)}</dd><dt>Glasses</dt><dd>${esc(p.specs)}</dd>${p.dob ? `<dt>Born</dt><dd>${esc(new Date(p.dob).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }))}</dd>` : ""}${p.lastTest ? `<dt>Last sight test</dt><dd>${esc(new Date(p.lastTest).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }))}</dd>` : ""}<dt>Home visit reason</dt><dd>${p.eligibility ? esc(p.eligibility) : `<span class="late">Not recorded</span>`}</dd>${p.rep ? `<dt>Next of kin</dt><dd>${esc(p.rep)}</dd>` : ""}${p.email ? `<dt>Email</dt><dd>${esc(p.email)}</dd>` : ""}<dt>Area</dt><dd>${esc(p.pc)}</dd></dl></div>
    <div class="sec"><h3>History</h3>${p.history.length ? `<ul class="hist">${p.history.map((h) => `<li><div><div class="d">${esc(h.label)}${h.by ? " · " + esc(h.by) : ""}</div>${esc(h.body)}</div></li>`).join("")}</ul>` : `<p class="muted" style="margin:0;font-size:13.5px">First visit.</p>`}</div>
    ${a ? `<div class="actionbar">${a.status === "booked" ? `<button class="btn danger" type="button" data-act="open-appt" data-id="${a.id}">${icon("x")}Cancel</button>` : ""}${act ? `<button class="btn" type="button" data-act="status" data-v="${act.v}" data-id="${a.id}">${icon(act.ic)}${act.label}</button>` : ""}</div>` : ""}`;
}

/* ============ Drawers ============ */
function openDrawer(d) { UI.drawer = d; renderDrawer(); }
function closeDrawer() { UI.drawer = null; UI.flow = null; UI.book = null; UI.imp = null; /* the file stays only as long as the drawer is open */ $("#drawer-root").innerHTML = ""; }
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
  else if (d.kind === "booklink") inner = bookLinkModal();
  else if (d.kind === "report") inner = reportDrawer(d.data);
  else if (d.kind === "invoices") inner = invoicesDrawer(d.data);
  else if (d.kind === "soon") inner = soonModal(d.id);
  else if (d.kind === "roadmap") inner = roadmapDrawer();
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
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, className: "lmap-tiles", referrerPolicy: "origin", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' })
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
      <div class="seg imp-filter" role="group" aria-label="Day">${(META.days || []).map((x, i) => `<button type="button" data-act="plans-day" data-v="${i}" aria-pressed="${i === day}">${i === 0 ? "Today" : esc(x.slice(0, 3))}</button>`).join("")}</div>
      ${!list ? `<p class="muted">Planning…</p>` : `${total ? `<div class="callout forest" style="margin-bottom:12px">${icon("car")}<div><b>${mins(total)} less driving ${day === 0 ? "today" : "on " + esc(dayName(day))}</b><div style="margin-top:2px">Across ${list.filter((p) => p.changed).length} clinician${list.filter((p) => p.changed).length === 1 ? "" : "s"}.</div></div></div>` : ""}
        ${list.map((p) => `<div class="plan-row"><span class="avatar sm" style="background:${(cln(p.clinicianId) || {}).color}">${initials(p.clinician)}</span>
          <div style="min-width:0;flex:1"><b>${esc(p.clinician)}</b><div class="muted" style="font-size:12.5px">${p.planned.length + p.fixed.length} visits · ${p.changed ? `${mins(p.savedMin)} less driving, ${p.changed} new time${p.changed === 1 ? "" : "s"}` : p.applied ? "Planned" : "Already a good order"}</div>${p.warnings.length ? `<div class="ir-m">${p.warnings.map((w) => `<span>${esc(w)}</span>`).join("")}</div>` : ""}</div>
          ${p.applied ? `<span class="badge b-ok">Applied</span>` : `<button class="btn secondary sm" type="button" data-act="route" data-c="${p.clinicianId}" data-d="${day}">${icon("pin")}See</button>${p.changed ? `<button class="btn sm" type="button" data-act="plans-apply" data-c="${p.clinicianId}">${icon("check")}Apply</button>` : ""}`}</div>`).join("")}`}
    </div>
    ${list && list.some((p) => p.changed && !p.applied) ? `<div class="drawer-f"><button class="btn" type="button" data-act="plans-apply-all">${icon("check")}Apply all and text patients</button></div>` : ""}`;
}
async function loadPlans(day) {
  UI.drawer.day = day; UI.drawer.list = null; renderDrawer();
  const cs = S.clinicians;
  UI.drawer.list = await Promise.all(cs.map((c) => api("GET", `/api/route/plan?clinician=${c.id}&day=${day}`)));
  renderDrawer();
}
/* ---------- What's coming: placeholders for features not built yet, clearly labelled ---------- */
// Nothing here pretends to work: each button opens a short note on what's coming. No dates are promised.
// "next" = smaller pieces to come first; "later" = bigger pieces that depend on partners or more work.
const ROADMAP = [
  { id: "persist", when: "next", area: "Platform", title: "Your data kept for good, hosted in the UK", body: "A permanent database (PostgreSQL) in a London data centre, encrypted, with daily backups and tested restores. This demo resets on purpose." },
  { id: "reset", when: "next", area: "Sign-in", title: "Password reset and your own authenticator", body: "Each person sets their own password and links their own authenticator app, with recovery codes and reset by email." },
  { id: "import", when: "next", area: "Getting started", title: "Bring visits and the waiting list across", body: "Patients can already be imported from a spreadsheet. Next: upcoming visits and the waiting list too, so nothing has to be typed in twice." },
  { id: "recall-auto", when: "next", area: "Recalls", title: "Recall texts sent automatically", body: "Recall texts go out on their own when a sight test falls due, with the booking link, instead of the office pressing Text link." },
  { id: "card", when: "next", area: "Payments", title: "Take card payments on the doorstep", body: "Take a card payment on the clinician's phone or a card reader at the end of the visit, marked paid on the invoice straight away." },
  { id: "xero", when: "next", area: "Payments", title: "Sync invoices to Xero or QuickBooks", body: "Invoices and payments flow into your accounts package, so nothing is typed in twice." },
  { id: "carehome", when: "next", area: "Payments", title: "Care-home billing", body: "Bill a care home for several residents seen on one visit, on one invoice." },
  { id: "ai-notes", when: "next", area: "Records", title: "Draft notes with AI", body: "Dictate or record the visit and get a draft note to check and save. Nothing is saved without the clinician approving it." },
  { id: "letters", when: "next", area: "Records", title: "Letters and pre-visit forms", body: "GP and referrer letters from templates, and forms patients or carers fill in before the visit (consent, history), saved to the record." },
  { id: "images", when: "next", area: "Records", title: "Fundus photos and scans", body: "Photos from a handheld fundus camera, and scan reports, saved into the patient's record from the clinician's phone." },
  { id: "pcse-online", when: "later", area: "NHS claims", title: "PCSE Online: notifications and GOS claims", body: "Lodge and cancel pre-visit notifications, and submit GOS 6 claims, straight from Domi instead of typing them into PCSE Online. Needs PCSE to accept Domi as a connected practice system." },
  { id: "stock", when: "later", area: "Practice", title: "Lab orders and frames", body: "Follow each pair of glasses from order to the lab and back, and book the delivery visit the day they arrive. Frame stock carried in the car, too." },
  { id: "apps", when: "later", area: "Clinicians", title: "iPhone and Android apps", body: "The clinician app in the App Store and Google Play. Today it runs in the phone's browser and works offline." },
];
const RM = Object.fromEntries(ROADMAP.map((r) => [r.id, r]));
/** A placeholder button for something not built yet: says so, and explains when clicked. */
const soon = (id, label, ic = "bolt", cls = "btn secondary sm") => `<button class="${cls} soon" type="button" data-act="soon" data-id="${id}">${icon(ic)}${label}<span class="soon-pill">Soon</span></button>`;
function soonModal(id) {
  const r = RM[id];
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><div><div class="caps">${esc(r.area)} · ${r.when === "next" ? "Coming next" : "Coming later"}</div><h2 style="margin-top:6px;font-size:28px">${esc(r.title)}</h2></div>${closeX}</div>
    <p style="margin:10px 0 0">${esc(r.body)}</p>
    <p class="muted" style="font-size:13px;margin:14px 0 0">${icon("clock")} Not in this demo yet.</p>
    <div style="display:flex;gap:8px;margin-top:16px">${S ? `<button class="btn secondary sm" type="button" data-act="roadmap">See everything that's coming</button>` : ""}</div>`;
}
function roadmapDrawer() {
  const group = (w) => ROADMAP.filter((r) => r.when === w).map((r) => `<li><span class="rm-area">${esc(r.area)}</span><b>${esc(r.title)}</b><span class="muted">${esc(r.body)}</span></li>`).join("");
  return `<div class="drawer-h"><div><div class="caps">Roadmap</div><h2 style="margin-top:6px">What's coming</h2></div>${closeX}</div>
    <div class="drawer-b">
      <p class="muted" style="margin:0 0 14px">Everything here is planned but not in the demo yet. Features marked <span class="soon-pill">Soon</span> around the app open these notes.</p>
      <h3 class="road-h">Coming next</h3><ul class="road">${group("next")}</ul>
      <h3 class="road-h">Coming later</h3><ul class="road">${group("later")}</ul>
    </div>`;
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
      <dl class="kv"><dt>Visit</dt><dd>${t.name} · ${t.dur} min</dd><dt>Address</dt><dd>${esc(p.addr)}, ${esc(p.pc)}</dd><dt>Phone</dt><dd><span class="mono">${esc(p.phone)}</span> · prefers ${esc(p.contact.toLowerCase())}</dd><dt>Glasses</dt><dd>${esc(p.specs)}</dd>${p.alerts.length ? `<dt>Notes</dt><dd>${esc(p.alerts.join(". "))}</dd>` : ""}</dl>
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
  return { patientId: v("bk-p"), name: v("bk-name"), pc: DomiAreas.read(document, "bk-pc"), addr: v("bk-addr"), phone: v("bk-phone"), type: v("bk-type"), avail: v("bk-avail") };
}
/* ---------- Importing patients from a spreadsheet ---------- */
// The file is read in the browser and sent for checking; nothing is saved until the office presses Import.
const IMPORT_TEMPLATE = "First name,Surname,Date of birth,Address,Town,Postcode,Mobile,Other phone,Email,Reason for home visit,Next of kin,Next of kin phone,Access notes,Glasses,Last sight test,Notes\n";
function importDrawer() {
  const I = UI.imp || (UI.imp = {});
  const head = (cap, title) => `<div class="drawer-h"><div><div class="caps">${cap}</div><h2 style="margin-top:6px">${title}</h2></div>${closeX}</div>`;
  if (I.done) {
    const d = I.done;
    return `${head("Import finished", `${d.imported} patient${d.imported === 1 ? "" : "s"} added`)}<div class="drawer-b">
      <ol class="steps">
        <li class="step ok"><span class="ic">${icon("check")}</span><div><div class="st">${d.imported} added to Domi</div><div class="sd">Each record notes it came from the spreadsheet. Search for them under Patients.</div></div></li>
        ${d.recalls ? `<li class="step ok"><span class="ic">${icon("cal")}</span><div><div class="st">${d.recalls} due a sight test</div><div class="sd">They're on the recall list and in the refill pool, so a cancellation near them can go to them.</div></div></li>` : ""}
        ${d.duplicates ? `<li class="step"><span class="ic">${icon("copy")}</span><div><div class="st">${d.duplicates} skipped as already on Domi</div><div class="sd">Matched by mobile number, or name with postcode or date of birth.</div></div></li>` : ""}
        ${d.errors ? `<li class="step"><span class="ic">${icon("x")}</span><div><div class="st">${d.errors} skipped with problems</div><div class="sd">Fix them in the spreadsheet and import the file again: anyone already added is skipped next time.</div></div></li>` : ""}
      </ol>
      <div class="callout apricot" style="margin-top:16px">${icon("bolt")}<div><b>Now stop using the spreadsheet</b><div style="margin-top:2px">From here on, add and change patients in Domi only, so there's one up-to-date record. Delete or archive the sheet once you've checked the import.</div></div></div>
    </div><div class="drawer-f"><button class="btn ghost" type="button" data-act="import-again">Import another file</button><button class="btn" type="button" data-act="close">Done</button></div>`;
  }
  if (!I.pv) {
    return `${head("Getting started", "Import patients")}<div class="drawer-b">
      <p class="muted" style="margin:0 0 14px;font-size:13.5px">Bring your patient list across from a spreadsheet in one go. You'll see every row checked before anything is saved.</p>
      <ol class="imp-how">
        <li><b>Save your sheet as a CSV file.</b> Google Sheets: <i>File → Download → Comma-separated values</i>. Excel: <i>Save As → CSV UTF-8</i>.</li>
        <li><b>Choose the file below.</b> Domi works out which column is which; you can change any of them.</li>
        <li><b>Check the preview, then import.</b> Problems and possible duplicates are shown first, and skipped.</li>
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
  const shown = pv.rows.filter((r) => f === "all" || (f === "problems" ? r.status === "error" : f === "dup" ? r.status === "duplicate" : r.status === "ready" && r.warnings.length));
  const badge = (r) => r.status === "error" ? `<span class="badge b-crit">Won't import</span>` : r.status === "duplicate" ? `<span class="badge b-plain">Already on Domi</span>` : r.warnings.length ? `<span class="badge b-warn">Check</span>` : `<span class="badge b-ok">Ready</span>`;
  const LIMIT = 150;
  return `${head(`${esc(I.name || "Your file")} · ${c.total} row${c.total === 1 ? "" : "s"}`, "Check before importing")}<div class="drawer-b">
    ${pv.missing.length ? `<div class="err" role="alert" style="margin-bottom:12px">Choose which column holds ${esc(pv.missing.join(" and "))}.</div>` : ""}
    <details class="imp-map" ${pv.missing.length || I.openMap ? "open" : ""}><summary>Columns · ${pv.mapping.filter(Boolean).length} of ${pv.headers.length} used</summary>
      <table class="imp-cols"><thead><tr><th>Your column</th><th>Example</th><th>Goes into</th></tr></thead><tbody>
      ${pv.headers.map((h, i) => `<tr><td><b>${esc(h || "(no heading)")}</b></td><td class="muted">${esc(pv.samples[i] || "")}</td><td><select class="input sm imp-col" data-i="${i}" aria-label="Field for ${esc(h)}">${fieldOpts(pv.mapping[i])}</select></td></tr>`).join("")}
      </tbody></table></details>
    <div class="seg imp-filter" role="group" aria-label="Show rows">
      <button type="button" data-act="imp-filter" data-v="all" aria-pressed="${f === "all"}">All ${c.total}</button>
      <button type="button" data-act="imp-filter" data-v="warn" aria-pressed="${f === "warn"}">To check ${c.warnings}</button>
      <button type="button" data-act="imp-filter" data-v="dup" aria-pressed="${f === "dup"}">Duplicates ${c.duplicate}</button>
      <button type="button" data-act="imp-filter" data-v="problems" aria-pressed="${f === "problems"}">Won't import ${c.error}</button>
    </div>
    <ul class="imp-rows">${shown.slice(0, LIMIT).map((r) => `<li class="${r.status}"><div class="ir-h"><span class="mono muted">Row ${r.line}</span><b>${esc(r.name || "(no name)")}</b><span class="muted">${esc(r.pc || "")}${r.age ? " · " + r.age : ""}</span>${badge(r)}</div>
      ${r.errors.length || r.warnings.length || r.duplicateOf ? `<div class="ir-m">${r.errors.map((m) => `<span class="e">${esc(m)}</span>`).join("")}${r.duplicateOf ? `<span>Same as ${esc(r.duplicateOf)}</span>` : ""}${r.warnings.map((m) => `<span>${esc(m)}</span>`).join("")}</div>` : ""}
      ${r.recallDue != null && r.recallDue <= 14 && r.status === "ready" ? `<div class="ir-m"><span class="ok">Sight test ${r.recallDue < 0 ? `overdue by ${-r.recallDue} days` : r.recallDue === 0 ? "due today" : `due in ${r.recallDue} days`}: will join recalls</span></div>` : ""}</li>`).join("")}
      ${shown.length > LIMIT ? `<li class="muted" style="text-align:center">…and ${shown.length - LIMIT} more</li>` : ""}${!shown.length ? `<li class="muted" style="text-align:center">Nothing here.</li>` : ""}</ul>
    ${I.err ? `<div class="err" role="alert" style="margin-top:12px">${esc(I.err)}</div>` : ""}
  </div>
  <div class="drawer-f"><button class="btn ghost" type="button" data-act="import-again">Choose another file</button><button class="btn" type="button" data-act="import-commit" ${!c.ready || pv.missing.length || I.busy ? "disabled" : ""}>${icon("check")}${I.busy ? "Importing…" : `Import ${c.ready} patient${c.ready === 1 ? "" : "s"}`}</button></div>`;
}
async function importPreview(mapping) {
  const I = UI.imp;
  I.busy = true; I.err = null; renderDrawer();
  try { I.pv = await api("POST", "/api/import/preview", { csv: I.csv, mapping }); }
  catch (e) { I.err = e.message; if (!mapping) I.csv = null; }
  I.busy = false; renderDrawer();
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
    : `<div class="callout apricot" style="margin-top:18px">${icon("clock")}<div><b>No gap this week fits without a long detour</b><div style="margin-top:2px">Put ${esc(B.results.patient.name)} on the waiting list and they'll be offered the next cancellation nearby.</div>
       <button class="btn sm" style="margin-top:10px" type="button" data-act="book-waitlist">${icon("plus")}Add to waiting list</button></div></div>`)
    : "";
  return `<div class="drawer-h"><div><div class="caps">New home visit</div><h2 style="margin-top:6px">Book a visit</h2></div>${closeX}</div>
  <form class="drawer-b" id="book-form">
    <p class="muted" style="margin:0 0 16px;font-size:13.5px">Searches every clinician's round this week for gaps where this visit fits, using road driving times between the full postcodes for the drive in and the drive on to the next patient, and ranks them by the extra driving they add.</p>
    <div class="field"><label for="bk-p">Patient</label><select class="input" id="bk-p" data-keep>${opts.map((p) => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)} · ${esc(p.pc)}${waiting.has(p.id) ? " · on waiting list" : ""}</option>`).join("")}<option value="new" ${sel === "new" ? "selected" : ""}>New patient…</option></select></div>
    <div id="bk-new" ${sel === "new" ? "" : "hidden"}><div class="row2"><div class="field"><label for="bk-name">Name</label><input class="input" id="bk-name" data-keep placeholder="e.g. Ruth Ingham"></div><div class="field"><label for="bk-addr">Address</label><input class="input" id="bk-addr" data-keep placeholder="House and street"></div></div>
      <div class="field">${DomiAreas.picker(S.areas || [], "bk-pc", DomiAreas.read(document, "bk-pc"))}</div>
      <div class="row2"><div class="field"><label for="bk-phone">Mobile</label><input class="input" id="bk-phone" data-keep placeholder="07700 900000" inputmode="tel"></div></div></div>
    <div class="row2"><div class="field"><label for="bk-type">Visit type</label><select class="input" id="bk-type" data-keep>${Object.entries(META.types).map(([k, v]) => `<option value="${k}">${v.name} · ${v.dur} min</option>`).join("")}</select></div>
    <div class="field"><label for="bk-avail">Patient is home</label><select class="input" id="bk-avail" data-keep>${Object.entries(META.avail).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div></div>
    <button class="btn block lg" type="submit">${icon("pin")}Find the best slots this week</button>
    ${results}
  </form>`;
}
function wlDrawer() {
  const busy = new Set(S.waitlist.filter((w) => w.status !== "booked").map((w) => w.patientId).concat(S.appts.filter(active).map((a) => a.patientId)));
  const opts = S.patients.filter((p) => !busy.has(p.id));
  return `<div class="drawer-h"><div><div class="caps">Waiting list</div><h2 style="margin-top:6px">Add a patient</h2></div>${closeX}</div>
  <form class="drawer-b" id="wl-form">
    <div class="field"><label for="wl-p">Patient</label><select class="input" id="wl-p" data-keep>${opts.map((p) => `<option value="${p.id}">${esc(p.name)} · ${esc(p.pc)}</option>`).join("")}<option value="new">New patient…</option></select></div>
    <div id="wl-new" ${opts.length ? "hidden" : ""}><div class="row2"><div class="field"><label for="wl-name">Name</label><input class="input" id="wl-name" data-keep placeholder="e.g. Ruth Ingham"></div></div>
      <div class="field">${DomiAreas.picker(S.areas || [], "wl-pc", DomiAreas.read(document, "wl-pc"))}</div>
      <div class="row2"><div class="field"><label for="wl-addr">Address</label><input class="input" id="wl-addr" data-keep placeholder="House and street"></div><div class="field"><label for="wl-phone">Mobile</label><input class="input" id="wl-phone" data-keep placeholder="07700 900000" inputmode="tel"></div></div></div>
    <div class="row2"><div class="field"><label for="wl-type">Visit type</label><select class="input" id="wl-type" data-keep>${Object.entries(META.types).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("")}</select></div>
    <div class="field"><label for="wl-prio">Priority</label><select class="input" id="wl-prio" data-keep><option value="routine">Routine</option><option value="soon">Soon</option><option value="urgent">Urgent</option></select></div></div>
    <div class="row2"><div class="field"><label for="wl-avail">Availability</label><select class="input" id="wl-avail" data-keep>${Object.entries(META.avail).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div class="field"><label for="wl-short">Short notice</label><select class="input" id="wl-short" data-keep><option value="1">Can take a same-day visit</option><option value="0">Needs 24h notice</option></select></div></div>
    <button class="btn block lg" type="submit">${icon("plus")}Add to waiting list</button>
  </form>`;
}
/* ---------- Patients: find anyone, open their record, change it, export or erase it ---------- */
const OPEN = ["booked", "enroute", "live"];
const searchText = (p) => [p.name, p.pc, p.pc.replace(/\s/g, ""), p.addr, p.phone.replace(/\s/g, ""), p.dob || ""].join(" ").toLowerCase();
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
async function openRecord(id) { const d = { kind: "patient", id, rec: null }; openDrawer(d); d.rec = await api("GET", "/api/patients/" + id); if (UI.drawer === d) renderDrawer(); }
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
    ${f("specs", "Glasses", p.specs, 'maxlength="80"')}
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
    : `<div class="callout apricot">${icon("clock")}<div><b>No other time this week fits</b><div style="margin-top:2px">Cancel the visit and add ${esc(first(p.name))} to the waiting list instead.</div></div></div>`;
  return `<div class="drawer-h"><div><div class="caps">Move a visit</div><h2 style="margin-top:6px">${esc(p.name)}</h2></div>${closeX}</div>
    <div class="drawer-b">
      <p class="muted" style="margin:0 0 14px;font-size:13.5px">Now ${a.day ? esc(dayName(a.day)) : "today"} at ${hm(a.start)} with ${esc(c.name)} (${T(a.type).name.toLowerCase()}). ${p.contact === "Call" ? `${esc(first(p.name))} asked to be phoned, so ring them with the new time.` : `${esc(first(p.name))} gets one text with the new time.`}${T(a.type).pvn ? " The PCSE notification moves with it, and an NHS sight test only goes 48 hours or more ahead." : ""}</p>
      ${slots}
    </div>`;
}

/* ---------- A free slot: who could take it, and booking whoever the office rings ---------- */
function gapDrawer(d) {
  const g = d.data;
  if (!g) return `<div class="drawer-h"><div><div class="caps">Free slot</div><h2 style="margin-top:6px">Finding who fits…</h2></div>${closeX}</div>`;
  const ok = g.candidates.filter((x) => x.ok), rest = g.candidates.filter((x) => !x.ok).slice(0, 4);
  const card = (x) => { const p = pat(x.patientId); return `<div class="offer ${x.byPhone ? "" : ""}"><div class="oh"><span><b>${esc(x.name)}</b> <span class="muted">· ${T(x.type).name}</span></span>${x.byPhone ? `<span class="badge b-apricot">${icon("phone")}Phone them</span>` : `<span class="badge b-plain">${x.score} pts</span>`}</div>
    <div class="why">${x.why.map((w) => `<span>${esc(w)}</span>`).join("")}</div>
    <div class="oa">${x.byPhone ? `<a class="btn secondary sm" href="tel:${esc(p.phone.replace(/\s/g, ""))}">${icon("phone")}<span class="mono">${esc(p.phone)}</span></a>` : ""}<button class="btn sm" type="button" data-act="gap-book" data-slot="${g.slotId}" data-w="${x.waitlistId}">${icon("check")}${x.byPhone ? "They said yes: book" : "Book " + esc(first(x.name))}</button></div></div>`; };
  return `<div class="drawer-h"><div><div class="caps">${esc(g.clinician)} · ${whenLabel(g.day, g.start)}</div><h2 style="margin-top:6px">Fill this slot</h2></div>${closeX}</div>
    <div class="drawer-b">
      <p class="muted" style="margin:0 0 14px;font-size:13.5px">${g.window} min free. Ring anyone below and book them here: they're texted the time (unless they asked for calls), ${esc(first(g.clinician))}'s phone updates, and anyone with an offer out hears it's gone.${g.offeredTo.length ? ` Waiting on a text reply from ${esc(g.offeredTo.join(" and "))}.` : ""}</p>
      ${ok.length ? `<div class="offers">${ok.slice(0, 8).map(card).join("")}</div>` : `<div class="callout apricot">${icon("clock")}<div><b>Nobody on the waiting list fits</b><div style="margin-top:2px">Use Book a visit to put in someone new.</div></div></div>`}
      ${rest.length ? `<details style="margin-top:16px"><summary class="muted">Who doesn't fit, and why</summary><ul class="mini">${rest.map((x) => `<li><b>${esc(x.name)}</b><div>${esc(x.reason)}</div></li>`).join("")}</ul></details>` : ""}
    </div>`;
}

/* ---------- The team: clinicians, office accounts, working hours ---------- */
const QUARTERS = []; for (let m = 9 * 60; m <= 17 * 60; m += 15) QUARTERS.push(m);
const hoursText = (h) => (META.days || []).map((d, i) => h[i] ? (h[i][0] === META.dayStart && h[i][1] === META.dayEnd ? null : `${d.slice(0, 3)} ${hm(h[i][0])}–${hm(h[i][1])}`) : `${d.slice(0, 3)} off`).filter(Boolean).join(" · ") || "Mon–Fri, 09:00–17:00";
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
      <div class="callout plain" style="margin-top:18px">${icon("shield")}<div>Everyone signs in with a password and a code from an authenticator app. Switching someone off signs them out on every device at once; their history stays.<div class="muted" style="margin-top:4px">In this demo, new accounts use the demo password. In the live system they're emailed an invitation to set their own.</div></div></div>
    </div>`;
}
function clinicianForm(t, id) {
  const c = t.clinicians.find((x) => x.id === id) || { name: "", role: "Optometrist", color: "#0089CF", areaName: "", patch: [], near: [], base: "", email: "", hours: (META.days || []).map(() => [META.dayStart, META.dayEnd]) };
  const opts = (sel) => QUARTERS.map((m) => `<option value="${m}" ${m === sel ? "selected" : ""}>${hm(m)}</option>`).join("");
  const f = (k, label, v, extra = "") => `<div class="field"><label for="tm-${k}">${label}</label><input class="input" id="tm-${k}" value="${esc(v || "")}" ${extra}></div>`;
  return `<div class="drawer-h"><div><div class="caps">${id ? "Edit clinician" : "New clinician"}</div><h2 style="margin-top:6px">${esc(c.name || "Add a clinician")}</h2></div>${closeX}</div>
  <form class="drawer-b" id="tm-clin" data-id="${esc(id || "")}">
    <div class="row2">${f("name", "Full name", c.name, 'maxlength="60" required')}<div class="field"><label for="tm-role">Role</label><select class="input" id="tm-role">${t.roles.map((r) => `<option ${r === c.role ? "selected" : ""}>${r}</option>`).join("")}</select></div></div>
    <div class="row2">${f("email", "Signs in with (email)", c.email, 'type="email" required')}<div class="field"><label for="tm-color">Colour in the diary</label><input class="input" id="tm-color" type="color" value="${esc(c.color)}" style="height:44px;padding:4px"></div></div>
    ${f("area", "Area name", c.areaName, 'maxlength="60" placeholder="e.g. Bolton & Bury"')}
    <div class="row2">${f("patch", "Postcode areas they cover", c.patch.join(", "), 'placeholder="BL1, BL2, BL3"')}${f("near", "Will also go to", c.near.join(", "), 'placeholder="BL4, M8"')}</div>
    ${f("base", "Starts the day from (postcode)", c.base, 'placeholder="BL1 5DN"')}
    <div class="caps" style="margin:8px 0 8px">Working hours</div>
    <div class="hours">${(META.days || []).map((d, i) => { const h = c.hours[i]; return `<div class="hrow"><label class="chk"><input type="checkbox" id="tm-w${i}" ${h ? "checked" : ""}> ${esc(d.slice(0, 3))}</label>
      <select class="input" id="tm-s${i}" aria-label="${esc(d)} start">${opts(h ? h[0] : META.dayStart)}</select><span class="muted">to</span><select class="input" id="tm-e${i}" aria-label="${esc(d)} finish">${opts(h ? h[1] : META.dayEnd)}</select></div>`; }).join("")}</div>
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
        <div class="price-grid">${Object.entries(META.types).map(([k, t]) => `<label><span>${esc(t.name)}</span><span class="price-in">£<input type="number" min="0" max="5000" step="5" data-price="${k}" value="${P[k] ?? 0}" aria-label="Price for ${esc(t.name)} in pounds"></span></label>`).join("")}</div>
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
    <div style="text-align:right"><b>${esc(i.practice.name)}</b><br><span class="muted">${esc(i.practice.addr)}<br>${esc(i.practice.email)}</span></div></div>
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
      <p class="muted" style="font-size:12.5px;margin-top:12px">Booked time is against a 9:00–17:00 day. Miles are estimated from distance between postcodes, including the drive from and back to each clinician's base. ${r.ratePence}p a mile is HMRC's approved rate for cars, for the first 10,000 business miles a year.</p>
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
  const refer = UI.drawer.refer, url = `${location.origin}/${refer ? "refer" : "book"}/${S.sandbox}`;
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
  if (UI.drawer && UI.drawer.kind === "qr") renderDrawer();
}

/* ============ Ticking clock ============ */
function tick() {
  if (!S) return;
  const n = demoNow();
  document.querySelectorAll("[data-clock]").forEach((e) => { e.textContent = hm(n); });
  const y = Math.max(0, Math.min((META.dayEnd - META.dayStart) * 1.4, (n - META.dayStart) * 1.4));
  document.querySelectorAll("[data-now]").forEach((e) => { e.style.top = y + "px"; });
}
setInterval(() => { tick(); if (UI.drawer && UI.drawer.kind === "flow" && UI.flow && !UI.flow.outcome) renderDrawer(); }, 15000);

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
  await viewAs(admin ? S.signedInAs.id : UI.lastClin);
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
      case "new-pair": UI.pair = null; renderDrawer(); break;
      case "close": closeDrawer(); break;
      case "pcse-done": el.disabled = true; await api("POST", `/api/pcse/${el.dataset.id}/done`); await load(); toast("Ticked off"); break;
      case "recall-text": el.disabled = true; await api("POST", `/api/recalls/${el.dataset.id}/text`); await load(); toast("Booking link texted"); break;
      case "recall-dismiss": await api("POST", `/api/recalls/${el.dataset.id}/dismiss`); await load(); toast("Removed from recalls and the refill pool"); break;
      case "soon": openDrawer({ kind: "soon", id: el.dataset.id }); break;
      case "roadmap": openDrawer({ kind: "roadmap" }); break;
      case "invoices": openDrawer({ kind: "invoices", data: await api("GET", "/api/invoices") }); break;
      case "inv-pay": { const m = document.querySelector(`[data-paymethod="${el.dataset.id}"]`).value; await api("POST", `/api/invoices/${el.dataset.id}/pay`, { method: m }); UI.drawer.data = await api("GET", "/api/invoices"); renderDrawer(); toast("Marked as paid"); break; }
      case "inv-void": await api("POST", `/api/invoices/${el.dataset.id}/void`); UI.drawer.data = await api("GET", "/api/invoices"); renderDrawer(); toast("Invoice voided"); break;
      case "inv-print": await printInvoice(el.dataset.id); break;
      case "report": openDrawer({ kind: "report", data: await api("GET", "/api/reports/week") }); break;
      case "report-csv": reportCsv(UI.drawer.data); toast("CSV downloaded"); break;
      case "booklink": openDrawer({ kind: "booklink" }); break;
      case "referlink": openDrawer({ kind: "booklink", refer: true }); break;
      case "referral": openDrawer({ kind: "referral", id: el.dataset.id }); break;
      case "ref-accept": {
        el.disabled = true;
        const body = { type: ($("#rf-type") || {}).value, prio: ($("#rf-prio") || {}).value, anyway: el.dataset.anyway === "1" };
        try { const r = await api("POST", `/api/referrals/${el.dataset.id}/accept`, body); await load(); closeDrawer(); toast(`Added to the waiting list${r.texted ? " and texted" : ""}`); }
        catch (e) { if (/already on Domi/.test(e.message)) { UI.drawer.dup = e.message; renderDrawer(); } else throw e; }
        break;
      }
      case "ref-decline": el.disabled = true; await api("POST", `/api/referrals/${el.dataset.id}/decline`, { reason: ($("#rf-why") || {}).value }); await load(); closeDrawer(); toast("Referral declined"); break;
      case "copy": try { await navigator.clipboard.writeText(el.dataset.v); toast("Link copied"); } catch (e) { toast("Couldn't copy. Select the link instead.", true); } break;
      case "route": await openRoute(el.dataset.c, el.dataset.d != null ? Number(el.dataset.d) : UI.view === "week" ? 0 : UI.day); break;
      case "map-focus": focusStop(el.dataset.map, Number(el.dataset.i)); break;
      case "plan-route": el.disabled = true; UI.drawer.plan = await api("GET", `/api/route/plan?clinician=${el.dataset.c}&day=${el.dataset.d}`); renderDrawer(); break;
      case "plan-cancel": UI.drawer.plan = null; renderDrawer(); break;
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
        const D = UI.drawer, ids = act === "plans-apply" ? [el.dataset.c] : D.list.filter((p) => p.changed && !p.applied).map((p) => p.clinicianId);
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
        if (B.map && B.map.i === i) { B.map = null; renderDrawer(); break; }
        const x = B.results.slots[i], p = B.results.patient;
        const q = new URLSearchParams({ clinician: x.clinicianId, day: x.day, pc: p.pc, start: x.start, type: B.results.type, name: p.name });
        B.map = { i, data: await api("GET", "/api/route?" + q) }; renderDrawer(); break;
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
      case "patients": openDrawer({ kind: "patients", q: "" }); break;
      case "open-rec": await openRecord(el.dataset.id); break;
      case "rec-edit": UI.drawer.edit = true; renderDrawer(); break;
      case "rec-edit-cancel": UI.drawer.edit = false; renderDrawer(); break;
      case "rec-export": {
        const d = UI.drawer, data = await api("GET", `/api/patients/${d.id}/export`);
        download(`${d.rec.name.replace(/[^A-Za-z]+/g, "-").toLowerCase()}-records.json`, JSON.stringify(data, null, 2), "application/json");
        toast("Downloaded. Send it securely, never by ordinary email."); break;
      }
      case "rec-erase": {
        const d = UI.drawer, v = ($("#erase-name") || {}).value || "";
        el.disabled = true;
        await api("POST", `/api/patients/${d.id}/erase`, { confirm: v });
        closeDrawer(); await load(); toast("Their details have been erased"); break;
      }
      case "book-for": UI.book = { patientId: el.dataset.id }; openDrawer({ kind: "book" }); break;
      case "move": { const d = { kind: "move", id: el.dataset.id, data: null }; openDrawer(d); d.data = await api("POST", `/api/appointments/${el.dataset.id}/move-options`, {}); if (UI.drawer === d) renderDrawer(); break; }
      case "move-to": {
        el.disabled = true;
        const r = await api("POST", `/api/appointments/${UI.drawer.id}/move`, { clinicianId: el.dataset.c, day: Number(el.dataset.d), start: Number(el.dataset.s) });
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
      case "gap": { const d = { kind: "gap", id: el.dataset.id, data: null }; openDrawer(d); d.data = await api("GET", `/api/gaps/${el.dataset.id}`); if (UI.drawer === d) renderDrawer(); break; }
      case "gap-book": {
        el.disabled = true;
        const r = await api("POST", `/api/gaps/${el.dataset.slot}/book`, { waitlistId: el.dataset.w });
        closeDrawer(); await load(); toast(`${r.patient} booked for ${r.day ? dayName(r.day) + " " : ""}${hm(r.start)} with ${first(r.clinician)}`); break;
      }
      case "team": { const d = { kind: "team", data: null }; openDrawer(d); d.data = await api("GET", "/api/team"); if (UI.drawer === d) renderDrawer(); break; }
      case "tm-edit": UI.drawer.edit = { kind: el.dataset.k, id: el.dataset.id || null }; renderDrawer(); break;
      case "tm-back": UI.drawer.edit = null; renderDrawer(); break;
      case "tm-active": {
        const on = el.dataset.v === "1", url = el.dataset.k === "clin" ? `/api/team/clinicians/${el.dataset.id}/active` : `/api/team/staff/${el.dataset.id}/active`;
        if (!on && !confirm("Switch this account off? They'll be signed out on every device.")) break;
        el.disabled = true;
        await api("POST", url, { active: on });
        UI.drawer.data = await api("GET", "/api/team"); await load(); toast(on ? "Switched back on" : "Switched off and signed out everywhere"); break;
      }
      case "do-cancel": {
        el.disabled = true;
        const r = await api("POST", "/api/appointments/" + el.dataset.id + "/cancel", { reason: $("#reason").value });
        if (!isAdmin()) { closeDrawer(); UI.pid = null; UI.rec = null; toast("Visit cancelled. The office system is refilling the slot."); await load(); break; }
        UI.flow = flowFrom(r); openDrawer({ kind: "flow" }); refetch(); break;
      }
      case "patient-cancel": el.disabled = true; closeDrawer(); await api("POST", "/api/demo/sms", { patientId: el.dataset.id, body: "CANCEL" }); break;
      case "reply": el.disabled = true; await api("POST", "/api/demo/sms", { patientId: el.dataset.p, body: el.dataset.v }); break;
      case "see-clin": UI.lastClin = "u-" + el.dataset.c; closeDrawer(); await viewAs(UI.lastClin); window.scrollTo(0, 0); break;
      case "add-wl": openDrawer({ kind: "wl" }); break;
      case "book": UI.book = {}; openDrawer({ kind: "book" }); break;
      case "import": UI.imp = {}; openDrawer({ kind: "import" }); break;
      case "import-again": UI.imp = {}; renderDrawer(); break;
      case "imp-filter": UI.imp.filter = el.dataset.v; renderDrawer(); break;
      case "import-template": { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([IMPORT_TEMPLATE], { type: "text/csv" })); a.download = "domi-patients-template.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); break; }
      case "import-commit": {
        const I = UI.imp; I.busy = true; I.err = null; renderDrawer();
        try { I.done = await api("POST", "/api/import/commit", { csv: I.csv, mapping: I.pv.mapping }); I.csv = null; I.pv = null; await load(); toast(`${I.done.imported} patients imported`); }
        catch (e) { I.err = e.message; }
        I.busy = false; renderDrawer(); break;
      }
      case "day": UI.view = "day"; UI.day = Number(el.dataset.v); render(); break;
      case "week": UI.view = "week"; render(); break;
      case "book-again": UI.book = {}; renderDrawer(); break;
      case "book-slot": {
        el.disabled = true;
        const r = await api("POST", "/api/bookings", Object.assign(bookInput(), { clinicianId: el.dataset.c, day: Number(el.dataset.d), start: Number(el.dataset.s) }));
        UI.book = { done: r }; UI.view = "day"; UI.day = r.day || 0; renderDrawer(); toast(`${r.patient} booked: ${r.day ? r.dayLabel + " " : ""}${r.label.slice(0, 5)} with ${first(r.clinician)}`); await load(); break;
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
    if (e.target.id === "book-form") {
      const b = bookInput(); UI.book = Object.assign(UI.book || {}, { patientId: b.patientId });
      UI.book.results = await api("POST", "/api/slots", b); UI.book.map = null; renderDrawer();
      const best = document.querySelector("#book-form .offer"); if (best) best.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    if (e.target.id === "pe-form") {
      const v = (id) => ($("#pe-" + id) || {}).value || "";
      const d = UI.drawer;
      const r = await api("PUT", "/api/patients/" + d.id, { name: v("name"), dob: v("dob"), addr: v("addr"), pc: DomiAreas.read(document, "pe-pc"), phone: v("phone"), contact: v("contact"), email: v("email"), eligibility: v("elig"), rep: v("rep"), specs: v("specs"), alerts: v("alerts") });
      d.edit = false; d.rec = await api("GET", "/api/patients/" + d.id + "?background=1"); await load();
      toast(r.changed.length ? `Saved: ${r.changed.join(", ")}` : "Nothing changed");
      return;
    }
    if (e.target.id === "tm-clin") {
      const v = (id) => ($("#tm-" + id) || {}).value || "";
      const hours = (META.days || []).map((_, i) => ($("#tm-w" + i) || {}).checked ? [Number(v("s" + i)), Number(v("e" + i))] : null);
      const id = e.target.dataset.id || undefined;
      await api("POST", "/api/team/clinicians", { id, name: v("name"), role: v("role"), email: v("email"), color: v("color"), areaName: v("area"), patch: v("patch"), near: v("near"), base: v("base"), hours });
      UI.drawer.edit = null; UI.drawer.data = await api("GET", "/api/team"); await load();
      toast(id ? "Saved" : "Clinician added. They can sign in now.");
      return;
    }
    if (e.target.id === "tm-staff") {
      const id = e.target.dataset.id || undefined;
      await api("POST", "/api/team/staff", { id, name: $("#ts-name").value, title: $("#ts-title").value, email: $("#ts-email").value });
      UI.drawer.edit = null; UI.drawer.data = await api("GET", "/api/team"); await load();
      toast(id ? "Saved" : "Office account added. They can sign in now.");
      return;
    }
    if (e.target.id === "wl-form") {
      await api("POST", "/api/waitlist", { patientId: $("#wl-p").value, name: $("#wl-name").value, pc: DomiAreas.read(document, "wl-pc"), addr: $("#wl-addr").value, phone: $("#wl-phone").value, type: $("#wl-type").value, prio: $("#wl-prio").value, avail: $("#wl-avail").value, shortNotice: $("#wl-short").value === "1" });
      closeDrawer(); await load(); toast("Added to the waiting list");
    }
    if (e.target.id === "pw-form") {
      const join = $("#join-code").value.trim();
      if (join && join.length !== 6) { toast("Demo codes are 6 characters, shown on the office screen", true); return; }
      const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
      try { await submitPassword($("#email").value.trim(), $("#password").value, join); } finally { btn.disabled = false; }
    }
    if (e.target.id === "code-form") {
      const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
      try { await submitCode($("#code").value); } finally { if (btn.isConnected) btn.disabled = false; }
    }
  } catch (err) { fail(err); }
});
document.addEventListener("change", async (e) => {
  try {
    if (e.target.id === "wl-p") $("#wl-new").hidden = e.target.value !== "new";
    if (e.target.id === "imp-file" && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 3e6) { UI.imp.err = "That file is over 3 MB. Split it into smaller files."; renderDrawer(); return; }
      UI.imp = { name: file.name, csv: await file.text() };
      await importPreview(null);
    }
    if (e.target.classList.contains("imp-col")) {
      const m = UI.imp.pv.mapping.slice(); m[Number(e.target.dataset.i)] = e.target.value || null;
      UI.imp.openMap = true; await importPreview(m);
    }
    if (e.target.id === "bk-p") { UI.book = { patientId: e.target.value }; $("#bk-new").hidden = e.target.value !== "new"; renderDrawer(); }
    if (["bk-type", "bk-avail"].includes(e.target.id) && UI.book && UI.book.results) { UI.book.results = null; renderDrawer(); }
    if (e.target.id === "offer-min") { await api("PUT", "/api/settings", { offerMinutes: Number(e.target.value) }); await load(); toast("Normal reply window: " + e.target.value + " min"); }
    if (e.target.id === "practice-name") { const v = e.target.value.trim(); if (v.length < 2) { e.target.value = S.settings.practice; return; } await api("PUT", "/api/settings", { practice: v }); await load(); toast("Texts now signed " + v); }
    if (e.target.id === "fee") { const v = Math.max(0, Math.round(Number(e.target.value) || 0)); await api("PUT", "/api/settings", { fee: v }); await load(); toast("Fee set to " + money(v) + " per visit"); }
    if (e.target.id === "me") { UI.lastClin = e.target.value; await viewAs(e.target.value); }
    if (e.target.dataset && e.target.dataset.price) { await api("PUT", "/api/settings", { prices: { [e.target.dataset.price]: Number(e.target.value) } }); await load(); toast("Price saved"); }
    if (e.target.id === "qr-as") { UI.qrAs = e.target.value; UI.pair = null; renderDrawer(); }
  } catch (err) { fail(err); }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "psearch") { UI.q = e.target.value; render(); }
  if (e.target.id === "pt-q" && UI.drawer) { UI.drawer.q = e.target.value; renderDrawer(); }
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
    if (!isAdmin()) await viewAs(S.signedInAs.id);
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
