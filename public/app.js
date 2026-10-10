/* Domi Hearing — browser app. Talks to the API in server/, renders office and clinician views,
   and listens for live events. Re-renders keep what the person is typing, their focus and scroll. */
(function () {
"use strict";

/* ============ API ============ */
let TOKEN = null, META = null, S = null, ES = null, fetchedAt = 0;
const UI = { tab: "today", pid: null, rec: null, q: "", drawer: null, flow: null, lastClin: "u-c1", busy: false };
try { TOKEN = localStorage.getItem("domi-token"); } catch (e) {}
const setToken = (t) => { TOKEN = t; try { t ? localStorage.setItem("domi-token", t) : localStorage.removeItem("domi-token"); } catch (e) {} };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: Object.assign({ "Content-Type": "application/json" }, TOKEN ? { Authorization: "Bearer " + TOKEN } : {}), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({ error: "The server sent something unexpected." }));
  if (res.status === 401 && url !== "/api/login") { setToken(null); S = null; closeDrawer(); render(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || "That didn't work. Try again.");
  return data;
}
const fail = (e) => toast(e.message, true);

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
const dayAppts = (c) => S.appts.filter((a) => a.clinicianId === c && active(a)).sort((x, y) => x.start - y.start);
const demoNow = () => S ? S.now + (Date.now() - fetchedAt) / 60000 : 620;
const money = (n) => "£" + Number(n || 0).toLocaleString("en-GB");

function toast(msg, bad) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.innerHTML = icon(bad ? "x" : "check") + esc(msg);
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

/* Keep typing, focus and scroll across re-renders (live updates arrive while people work). */
function snapshot(root) {
  const a = document.activeElement;
  return {
    id: a && root.contains(a) ? a.id : null, ss: a && a.selectionStart, se: a && a.selectionEnd,
    vals: [...root.querySelectorAll("[data-keep]")].map((e) => [e.id, e.value]),
    scroll: [...root.querySelectorAll("[data-scroll]")].map((e) => [e.dataset.scroll, e.scrollTop, e.scrollLeft]),
    y: window.scrollY,
  };
}
function restore(root, s) {
  s.vals.forEach(([id, v]) => { const e = document.getElementById(id); if (e && root.contains(e)) e.value = v; });
  s.scroll.forEach(([k, t, l]) => { const e = root.querySelector(`[data-scroll="${k}"]`); if (e) { e.scrollTop = t; e.scrollLeft = l; } });
  if (s.id) { const e = document.getElementById(s.id); if (e) { e.focus({ preventScroll: true }); try { if (s.ss != null) e.setSelectionRange(s.ss, s.se); } catch (err) {} } }
  window.scrollTo(0, s.y);
}
function paint(root, html) { const s = snapshot(root); root.innerHTML = html; restore(root, s); }

/* ============ Data + live updates ============ */
async function load() {
  S = await api("GET", "/api/state");
  fetchedAt = Date.now();
  if (S.user.clinicianId) UI.lastClin = "u-" + S.user.clinicianId;
  if (UI.pid) { try { UI.rec = await api("GET", "/api/patients/" + UI.pid + "?background=1"); } catch (e) { UI.pid = null; UI.rec = null; } }
  render();
  if (UI.drawer) renderDrawer();
}
let refetchT = null;
const refetch = () => { clearTimeout(refetchT); refetchT = setTimeout(() => load().catch(() => {}), 120); };

const EVENTS = ["refill.started", "appointment.updated", "offer.sent", "offer.declined", "offer.expired", "slot.filled", "slot.unfilled", "sms.received", "note.added", "waitlist.added", "settings.updated", "reset"];
function connect() {
  if (ES) ES.close();
  ES = new EventSource("/api/events?token=" + encodeURIComponent(TOKEN));
  const live = (on) => $("#clock").classList.toggle("off", !on);
  ES.addEventListener("hello", () => live(true));
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
    return;
  }
  if (type === "refill.started") {
    if (e.cancelled && e.cancelled.byText) toast(`${e.cancelled.patient} texted to cancel. Refilling ${hm(e.start)}.`);
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

async function signIn(userId, sandbox) {
  const r = await api("POST", "/api/login", { userId, sandbox });
  setToken(r.token);
  UI.tab = "today"; UI.pid = null; UI.rec = null;
  await load();
  connect();
}

/* ============ Render ============ */
function render() {
  const signedIn = !!S;
  $("#clock").hidden = !signedIn; $("#roles").hidden = !signedIn; $("#actions").hidden = !signedIn;
  if (!signedIn) { $("#app").innerHTML = signInView(); return; }
  $("#role-admin").setAttribute("aria-pressed", isAdmin());
  $("#role-clin").setAttribute("aria-pressed", !isAdmin());
  $("#open-phone").hidden = !isAdmin();
  paint($("#app"), isAdmin() ? officeView() : clinView());
  tick();
}

function signInView() {
  const users = META ? META.demoUsers : [];
  const params = new URLSearchParams(location.search);
  return `<div class="signin">
    <section class="signin-brand">
      <div>
        <div class="caps" style="color:inherit;opacity:.7">Domiciliary audiology</div>
        <h1 style="margin-top:14px">Hearing care that <em>comes to you.</em></h1>
        <p>A diary for home-visit audiology. When someone cancels, the next patient who can be seen is offered the slot by text, and the clinician's phone updates on its own.</p>
      </div>
      <ul class="features">
        <li><span class="ic">${icon("bolt")}</span><span><b>Cancellations refill themselves</b><em>Ranked by urgency, area, wait and travel time.</em></span></li>
        <li><span class="ic">${icon("phone")}</span><span><b>Built for the round</b><em>Visits, records and notes on the clinician's phone.</em></span></li>
        <li><span class="ic">${icon("shield")}</span><span><b>Every change audited</b><em>Who did what, and who opened which record.</em></span></li>
      </ul>
    </section>
    <section class="signin-form">
      <div><div class="caps">Private demo</div><h2 style="margin-top:8px">Start your own copy</h2>
      <p class="muted" style="margin:8px 0 0">You get a private copy of a sample diary. Nobody else sees your changes, and it resets whenever you like.</p></div>
      <div class="users">${users.map((u, i) => `<button class="user-opt ${i === 0 ? "primary" : ""}" type="button" data-act="signin" data-id="${u.id}">
        <span class="avatar" style="background:${u.color}">${initials(u.name)}</span>
        <span><b>${esc(u.name)}</b><div class="r">${u.role === "admin" ? "Office manager · sees every diary" : esc(u.title) + " · own round only"}</div></span>${icon("next")}</button>`).join("")}</div>
      <div class="divider">Joining from your phone?</div>
      <form class="join" id="join-form">
        <input class="input code-input" id="join-code" maxlength="6" placeholder="Demo code" value="${esc(params.get("join") || "")}" aria-label="Demo code" autocomplete="off">
        <select class="input" id="join-as" aria-label="Join as">${users.filter((u) => u.role !== "admin").map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}<option value="u-admin">Office</option></select>
        <button class="btn" type="submit">Join</button>
      </form>
    </section>
  </div>`;
}

/* ---------- Office ---------- */
function officeView() {
  const all = S.appts.filter(active), waiting = S.waitlist.filter((w) => w.status !== "booked"), m = S.metrics, st = S.settings;
  const nowM = demoNow();
  const left = all.filter((a) => a.status !== "done").length;
  return `<div class="shell">
    <div class="page-head">
      <div><div class="caps">Monday 12 October</div><h1 style="margin-top:6px">Today across the team</h1>
        <p>Three clinicians on the road. Cancel any visit and the best-matched patient from the waiting list is offered the slot straight away.</p></div>
      <div class="quick-stats">
        <div class="qs"><b>${all.length}</b><span>home visits</span></div>
        <div class="qs"><b>${left}</b><span>still to go</span></div>
        <div class="qs"><b>${waiting.length}</b><span>waiting list</span></div>
      </div>
    </div>
    <section class="income" aria-label="Income recovered">
      <div><div class="big">${money(m.recovered)}</div><div class="lab">recovered today from cancelled visits</div></div>
      <div class="kpi"><b>${m.refilled}<span style="font-size:18px;opacity:.7"> / ${m.cancellations}</span></b><div class="lab">cancellations refilled</div></div>
      <div class="kpi"><b>${m.avgRefillMin == null ? "–" : m.avgRefillMin < 1 ? "<1 min" : m.avgRefillMin + " min"}</b><div class="lab">average time to refill</div></div>
      <div class="kpi"><b>${money(m.atRisk)}</b><div class="lab">still unfilled</div></div>
      <div class="fee"><span>Your fee per visit</span><label>£<input id="fee" data-keep type="number" min="0" max="2000" step="5" value="${m.fee}" aria-label="Fee per visit in pounds"></label><span style="opacity:.7">Example figure. Set your own.</span></div>
    </section>
    <div class="grid">
      <section class="panel" aria-label="Diaries">
        <div class="panel-h"><h2>Diaries</h2>
          <div class="legend"><span><i class="sw" style="background:var(--surface)"></i>Booked</span><span><i class="sw" style="background:var(--warn-soft)"></i>On the way</span><span><i class="sw" style="background:var(--ok-soft)"></i>With patient</span><span><i class="sw" style="background:var(--subtle)"></i>Done</span><span><i class="sw" style="background:var(--apricot-soft)"></i>Moved forward</span></div>
        </div>
        <div class="board-wrap" data-scroll="board">${board(nowM)}</div>
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
          </div>
          <div class="hr"></div>
          <ul class="wl">${S.waitlist.map(wlItem).join("")}</ul>
        </section>
        <section class="panel" aria-label="Texts">
          <div class="panel-h"><h2>Texts</h2><span class="sub">${S.messages.length} today · ${META.smsProvider === "twilio" ? "sending live" : "demo outbox"}</span></div>
          ${S.messages.length ? `<div class="feed" data-scroll="feed">${S.messages.map(smsBubble).join("")}</div>`
            : `<div class="empty"><b>No texts yet</b>Click a booked visit in a diary to cancel it, or to play the patient texting CANCEL.</div>`}
        </section>
      </aside>
    </div></div>`;
}
function wlItem(w, i) {
  const p = pat(w.patientId), t = T(w.type);
  const badge = w.status === "booked" ? `<span class="badge b-ok">Booked</span>`
    : w.status === "offered" ? `<span class="badge b-apricot">Offered</span>`
    : `<span class="badge ${w.prio === "urgent" ? "b-crit" : w.prio === "soon" ? "b-warn" : "b-plain"}">${META.prio[w.prio].label}</span>`;
  return `<li class="${w.status === "booked" ? "booked" : ""}"><span class="pos">${w.status === "booked" ? icon("check") : i + 1}</span>
    <div style="min-width:0"><div class="nm">${esc(p.name)}</div>
      <div class="meta"><span>${t.name}</span><span>${district(p.pc)}</span><span>${META.avail[w.avail]}</span>${w.shortNotice ? "" : "<span>Needs 24h notice</span>"}<span>${w.days} days waiting</span></div></div>
    ${badge}</li>`;
}
function smsBubble(m) {
  const cls = m.dir === "in" ? "in" : (m.toClin ? "clin" : "");
  const who = m.dir === "in" ? `From ${esc(m.name)}` : `To ${esc(m.name)}`;
  return `<div class="sms ${cls}"><div class="who">${who} · <span class="mono">${esc(String(m.at || "").slice(0, 5))}</span></div><div class="bub">${esc(m.body)}</div></div>`;
}
function board(nowM) {
  const PX = 1.4, DS = META.dayStart, DE = META.dayEnd, H = (DE - DS) * PX;
  let ticks = "";
  for (let m = DS; m <= DE; m += 60) ticks += `<div class="tick mono" style="top:${(m - DS) * PX}px">${hm(m)}</div>`;
  const nowY = Math.max(0, Math.min(H, (nowM - DS) * PX));
  const lanes = S.clinicians.map((c, ci) => {
    const list = dayAppts(c.id);
    const blocks = list.map((a) => {
      const p = pat(a.patientId), t = T(a.type), top = (a.start - DS) * PX, h = Math.max(t.dur * PX - 4, 36);
      const cls = a.moved ? "moved" : a.status;
      const drive = a.drive >= 10 ? `<div class="drive" style="top:${top - a.drive * PX + 3}px">${icon("car")}${a.drive} min</div>` : "";
      const head = h < 52
        ? `<span class="row1"><span class="tm">${hm(a.start)}</span><span class="pn">${esc(p.name)}</span></span>`
        : `<span class="tm">${hm(a.start)}–${hm(a.start + t.dur)}</span><span class="pn">${esc(p.name)}</span>`;
      const extra = (h > 62 ? `<span class="ty">${t.name}</span>` : "")
        + (h > 84 && a.moved ? `<span class="badge b-apricot" style="margin-top:4px">${icon("bolt")}Moved forward</span>` : "")
        + (h > 84 && a.status === "enroute" ? `<span class="badge b-warn" style="margin-top:4px">${icon("car")}On the way</span>` : "");
      return `${drive}<button class="blk ${cls}" type="button" data-act="open-appt" data-id="${a.id}" style="top:${top}px;height:${h}px" aria-label="${esc(p.name)} at ${hm(a.start)}">${head}${extra}</button>`;
    }).join("");
    const filled = new Set(list.map((a) => a.start));
    const gaps = S.appts.filter((a) => a.clinicianId === c.id && a.status === "cancelled" && !filled.has(a.start)).map((a) => {
      const t = T(a.type), offers = S.offers.filter((o) => o.slot_id === a.id);
      const label = offers.length ? `Offer out · replies close ${esc(offers[0].deadline)}` : `Open slot · ${money(S.metrics.fee)} unfilled`;
      return `<div class="blk gap ${offers.length ? "offering" : ""}" style="top:${(a.start - DS) * PX}px;height:${t.dur * PX - 4}px"><span class="tm">${hm(a.start)}</span><span class="ty">${label}</span></div>`;
    }).join("");
    return `<div class="lane" style="height:${H}px;background-size:100% ${60 * PX}px">${blocks}${gaps}<div class="now" data-now style="top:${nowY}px">${ci === 0 ? `<span class="now-label mono" data-clock>${hm(nowM)}</span>` : ""}</div></div>`;
  }).join("");
  const heads = S.clinicians.map((c) => `<div class="col-h"><span class="avatar sm" style="background:${c.color}">${initials(c.name)}</span><div><div class="nm">${esc(c.name)}</div><div class="rl">${esc(c.role)} · ${esc(c.areaName)}</div></div></div>`).join("");
  return `<div class="board" style="grid-template-columns:56px repeat(${S.clinicians.length},minmax(210px,1fr))"><div class="col-h"></div>${heads}<div class="times" style="height:${H}px">${ticks}</div>${lanes}</div>`;
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
        <li>${icon("note")}<span>Patient record, audiogram and one-tap notes</span></li>
        <li>${icon("car")}<span>"On my way" texts the patient automatically</span></li>
        <li>${icon("bolt")}<span>Diary changes from the office arrive live</span></li>
      </ul></div>
    <div class="phone">
      <div class="ph-scroll" id="ph-scroll" data-scroll="phone">${body}</div>
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
  const list = dayAppts(c.id), done = list.filter((a) => a.status === "done").length;
  const moved = list.find((a) => a.moved && !a.seen);
  const nxt = list.find((a) => a.status !== "done");
  const rest = list.filter((a) => a !== nxt);
  const switcher = `<select class="who-select" id="me" aria-label="Switch clinician">${META.demoUsers.filter((u) => u.role === "clinician").map((u) => `<option value="${u.id}" ${u.id === "u-" + c.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select>`;
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
    const st = a.status === "done" ? `<span class="badge b-plain">Done</span>` : a.moved ? `<span class="badge b-apricot">${icon("bolt")}New</span>` : "";
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
    ${moved ? `<div class="banner">${icon("bolt")}<div><b>Your diary changed</b>${esc(moved.note)}</div></div>` : ""}
    ${hero}
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
function audiogram(a) {
  const FREQS = [250, 500, 1000, 2000, 4000, 8000], W = 320, H = 210, l = 36, r = 12, t = 14, b = 26, iw = W - l - r, ih = H - t - b;
  const x = (i) => l + i * (iw / (FREQS.length - 1));
  const y = (db) => t + (db + 10) / 130 * ih;
  let g = `<rect x="${l}" y="${y(-10)}" width="${iw}" height="${y(20) - y(-10)}" fill="var(--ok-soft)"/>`;
  for (let db = -10; db <= 120; db += 10) { g += `<line x1="${l}" x2="${W - r}" y1="${y(db)}" y2="${y(db)}" stroke="var(--line)" stroke-width="${db % 20 === 0 ? 1 : 0.5}"/>`; if (db % 20 === 0) g += `<text x="${l - 7}" y="${y(db) + 3}" text-anchor="end">${db}</text>`; }
  FREQS.forEach((f, i) => { g += `<line x1="${x(i)}" x2="${x(i)}" y1="${t}" y2="${H - b}" stroke="var(--line)" stroke-width=".5"/><text x="${x(i)}" y="${H - b + 15}" text-anchor="middle">${f >= 1000 ? f / 1000 + "k" : f}</text>`; });
  const line = (arr, col) => `<polyline fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" points="${arr.map((v, i) => x(i) + "," + y(v)).join(" ")}"/>`;
  g += line(a.R, "var(--ear-r)") + line(a.L, "var(--ear-l)");
  a.R.forEach((v, i) => { g += `<circle cx="${x(i)}" cy="${y(v)}" r="4.5" fill="var(--surface)" stroke="var(--ear-r)" stroke-width="1.8"/>`; });
  a.L.forEach((v, i) => { const cx = x(i), cy = y(v); g += `<path d="M${cx - 4} ${cy - 4}L${cx + 4} ${cy + 4}M${cx + 4} ${cy - 4}L${cx - 4} ${cy + 4}" stroke="var(--ear-l)" stroke-width="2" stroke-linecap="round"/>`; });
  return `<svg class="aud" viewBox="0 0 ${W} ${H}" role="img" aria-label="Audiogram: right ear circles, left ear crosses">${g}<text x="6" y="${t + ih / 2}" transform="rotate(-90 10 ${t + ih / 2})" text-anchor="middle">dB HL</text></svg>
    <div class="aud-leg"><span><b style="color:var(--ear-r)">O</b> Right</span><span><b style="color:var(--ear-l)">X</b> Left</span><span>Green band: normal hearing</span></div>`;
}
function record(p) {
  const a = S.appts.find((x) => x.patientId === p.id && active(x) && x.status !== "done");
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
    <div class="sec"><h3>Visit notes ${a && a.status === "live" ? `<span class="badge b-ok">In progress</span>` : ""}</h3>
      <div class="chips">${["Otoscopy clear", "Wax removed R", "Wax removed L", "Aids cleaned & retubed", "Domes replaced", "Fine-tuned gain", "Advised on batteries", "Follow-up in 6 weeks"].map((c) => `<button type="button" data-act="chip">${c}</button>`).join("")}</div>
      <textarea class="note" id="note-${p.id}" data-keep placeholder="What did you do on this visit?"></textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn sm" type="button" data-act="save-note" data-id="${p.id}">${icon("check")}Save to record</button></div>
    </div>
    <div class="sec"><h3>Hearing</h3>${p.audio ? audiogram(p.audio) : `<p class="muted" style="margin:0;font-size:13.5px">No audiogram yet. Results are added after the assessment.</p>`}</div>
    <div class="sec"><h3>Details</h3><dl class="kv"><dt>Phone</dt><dd class="mono">${esc(p.phone)}</dd><dt>Hearing aids</dt><dd>${esc(p.aids)}</dd><dt>Area</dt><dd>${esc(p.pc)}</dd></dl></div>
    <div class="sec"><h3>History</h3>${p.history.length ? `<ul class="hist">${p.history.map((h) => `<li><div><div class="d">${esc(h.label)}${h.by ? " · " + esc(h.by) : ""}</div>${esc(h.body)}</div></li>`).join("")}</ul>` : `<p class="muted" style="margin:0;font-size:13.5px">First visit.</p>`}</div>
    ${a ? `<div class="actionbar">${a.status === "booked" ? `<button class="btn danger" type="button" data-act="open-appt" data-id="${a.id}">${icon("x")}Cancel</button>` : ""}${act ? `<button class="btn" type="button" data-act="status" data-v="${act.v}" data-id="${a.id}">${icon(act.ic)}${act.label}</button>` : ""}</div>` : ""}`;
}

/* ============ Drawers ============ */
function openDrawer(d) { UI.drawer = d; renderDrawer(); }
function closeDrawer() { UI.drawer = null; UI.flow = null; $("#drawer-root").innerHTML = ""; }
function renderDrawer() {
  const d = UI.drawer; if (!d || !S) return;
  let inner = "";
  if (d.kind === "appt") inner = apptDrawer(d.id);
  else if (d.kind === "flow") inner = flowDrawer();
  else if (d.kind === "wl") inner = wlDrawer();
  else if (d.kind === "qr") inner = qrModal();
  if (!inner) { closeDrawer(); return; }
  const root = $("#drawer-root");
  const html = d.kind === "qr" ? `<div class="scrim" data-act="close"></div><div class="modal" role="dialog" aria-modal="true" aria-label="Open on phone">${inner}</div>`
    : `<div class="scrim" data-act="close"></div><aside class="drawer" role="dialog" aria-modal="true">${inner}</aside>`;
  const fresh = !root.firstChild;
  paint(root, html);
  if (fresh) { const f = root.querySelector("select, button:not(.x), input"); if (f) f.focus({ preventScroll: true }); }
}
const closeX = `<button class="icon-btn" type="button" data-act="close" aria-label="Close">${icon("x")}</button>`;

function apptDrawer(id) {
  const a = S.appts.find((x) => x.id === id); if (!a) return "";
  const p = pat(a.patientId), t = T(a.type), c = cln(a.clinicianId);
  const canCancel = a.status === "booked" || a.status === "enroute";
  const status = { booked: ["b-forest", "Booked"], enroute: ["b-warn", "On the way"], live: ["b-ok", "With patient"], done: ["b-plain", "Done"] }[a.status] || ["b-plain", a.status];
  return `<div class="drawer-h"><div><div class="caps">${hm(a.start)}–${hm(a.start + t.dur)} · ${esc(c.name)}</div><h2 style="margin-top:6px">${esc(p.name)}</h2>
      <div style="display:flex;gap:6px;margin-top:8px"><span class="badge ${status[0]}">${status[1]}</span>${a.moved ? `<span class="badge b-apricot">${icon("bolt")}Moved forward</span>` : ""}</div></div>${closeX}</div>
    <div class="drawer-b">
      <dl class="kv"><dt>Visit</dt><dd>${t.name} · ${t.dur} min</dd><dt>Address</dt><dd>${esc(p.addr)}, ${esc(p.pc)}</dd><dt>Phone</dt><dd><span class="mono">${esc(p.phone)}</span> · prefers ${esc(p.contact.toLowerCase())}</dd><dt>Hearing aids</dt><dd>${esc(p.aids)}</dd>${p.alerts.length ? `<dt>Notes</dt><dd>${esc(p.alerts.join(". "))}</dd>` : ""}</dl>
      ${canCancel ? `<div class="hr" style="margin:20px 0"></div>
        <div class="field"><label for="reason">Why is it cancelled?</label><select class="input" id="reason" data-keep>${META.reasons.map((r) => `<option>${r}</option>`).join("")}</select></div>
        <button class="btn danger block lg" type="button" data-act="do-cancel" data-id="${a.id}">${icon("x")}Cancel and refill this slot</button>
        <div class="callout plain" style="margin-top:16px">${icon("phone")}<div><b>Or play the patient</b><div class="muted" style="margin-top:2px">Most cancellations come in by text. Send "CANCEL" from ${esc(first(p.name))}'s phone and watch the slot refill with nobody in the office touching it.</div>
          <button class="btn ghost sm" style="margin-top:10px" type="button" data-act="patient-cancel" data-id="${p.id}">${icon("send")}Text CANCEL as ${esc(first(p.name))}</button></div></div>`
        : `<p class="muted" style="margin-top:20px">${a.status === "done" ? "This visit is complete." : "The clinician is with this patient now."}</p>`}
    </div>`;
}

/* The refill story. Built from the API response, then kept current by live events. */
const roundFrom = (r) => ({ round: r.round, plan: r.plan, deadline: r.deadline, offers: (r.offers || []).map((o) => Object.assign({ status: "pending" }, o)) });
function flowFrom(r) {
  return {
    slotId: r.slotId, clinicianId: r.clinicianId, clinician: r.clinician, start: r.start, window: r.window, plan: r.plan,
    cancelled: r.cancelled || {}, candidates: r.candidates || [],
    rounds: r.outcome === "offered" ? [roundFrom(r)] : [],
    outcome: r.outcome === "offered" ? null : r.outcome, booking: r.booking || null, why: r.why || null,
  };
}
const step = (state, title, desc, extra) => `<li class="step ${state}"><span class="ic">${icon(state === "ok" ? "check" : state === "wait" ? "spin" : state === "no" ? "x" : "send")}</span><div><div class="st">${title}</div>${desc ? `<div class="sd">${desc}</div>` : ""}${extra || ""}</div></li>`;
function planText(f) {
  const p = f.plan || {}, c = first(f.clinician || ""), lead = Math.round(f.start - demoNow());
  if (S.settings.mode === "instant") return `Instant mode: the best match is booked straight in and told by text.`;
  if (p.mode === "parallel") return `The visit is ${lead} min away and ${c} needs to leave in time, so the top ${p.count} are asked at once. The first YES gets it.`;
  if (p.mode === "single") return `There's time, so one person is asked at a time with ${p.windowMin} min to reply. That leaves room for several rounds before ${c} sets off.`;
  return null;
}
function flowDrawer() {
  const f = UI.flow; if (!f) return "";
  const c = first(f.clinician);
  const steps = [];
  steps.push(step("ok", `${hm(f.start)} slot freed`, `${esc(f.cancelled.patient || "The patient")} ${f.cancelled.byText ? "texted CANCEL" : "cancelled: " + esc(String(f.cancelled.reason || "").toLowerCase())}. ${f.window} min free before ${esc(c)}'s next visit.`));
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
  if (f.outcome === "booked") steps.push(step("ok", `${esc(f.booking.patient)} booked at ${hm(f.start)}`, `${esc(c)} has been texted and the visit is on the phone now.${f.booking.instant ? " Booked instantly." : ""}`));
  if (f.outcome === "unfilled") steps.push(step("no", "Slot left open", esc(f.why || "Nobody suitable could take it.") + ". It stays visible in the diary."));
  const note = planText(f);
  return `<div class="drawer-h"><div><div class="caps">${esc(f.clinician)} · ${hm(f.start)}</div><h2 style="margin-top:6px">${f.outcome === "booked" ? "Slot refilled" : f.outcome === "unfilled" ? "Couldn't refill" : "Refilling the slot"}</h2></div>${closeX}</div>
    <div class="drawer-b">${note && f.rounds.length ? `<div class="callout forest">${icon("clock")}<div>${esc(note)}</div></div>` : ""}<ol class="steps">${steps.join("")}</ol></div>
    ${f.outcome ? `<div class="drawer-f">${f.outcome === "booked" ? `<button class="btn ghost" type="button" data-act="see-clin" data-c="${f.clinicianId}">See ${esc(c)}'s phone</button>` : ""}<button class="btn" type="button" data-act="close">Done</button></div>` : ""}`;
}
function wlDrawer() {
  const busy = new Set(S.waitlist.filter((w) => w.status !== "booked").map((w) => w.patientId).concat(S.appts.filter(active).map((a) => a.patientId)));
  const opts = S.patients.filter((p) => !busy.has(p.id));
  return `<div class="drawer-h"><div><div class="caps">Waiting list</div><h2 style="margin-top:6px">Add a patient</h2></div>${closeX}</div>
  <form class="drawer-b" id="wl-form">
    <div class="field"><label for="wl-p">Patient</label><select class="input" id="wl-p" data-keep>${opts.map((p) => `<option value="${p.id}">${esc(p.name)} · ${esc(p.pc)}</option>`).join("")}<option value="new">New patient…</option></select></div>
    <div id="wl-new" ${opts.length ? "hidden" : ""}><div class="row2"><div class="field"><label for="wl-name">Name</label><input class="input" id="wl-name" data-keep placeholder="e.g. Ruth Ingham"></div><div class="field"><label for="wl-pc">Postcode district</label><input class="input" id="wl-pc" data-keep placeholder="LS16"></div></div>
      <div class="row2"><div class="field"><label for="wl-addr">Address</label><input class="input" id="wl-addr" data-keep placeholder="House and street"></div><div class="field"><label for="wl-phone">Mobile</label><input class="input" id="wl-phone" data-keep placeholder="07700 900000" inputmode="tel"></div></div></div>
    <div class="row2"><div class="field"><label for="wl-type">Visit type</label><select class="input" id="wl-type" data-keep>${Object.entries(META.types).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("")}</select></div>
    <div class="field"><label for="wl-prio">Priority</label><select class="input" id="wl-prio" data-keep><option value="routine">Routine</option><option value="soon">Soon</option><option value="urgent">Urgent</option></select></div></div>
    <div class="row2"><div class="field"><label for="wl-avail">Availability</label><select class="input" id="wl-avail" data-keep>${Object.entries(META.avail).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div class="field"><label for="wl-short">Short notice</label><select class="input" id="wl-short" data-keep><option value="1">Can take a same-day visit</option><option value="0">Needs 24h notice</option></select></div></div>
    <button class="btn block lg" type="submit">${icon("plus")}Add to waiting list</button>
  </form>`;
}
function qrModal() {
  const as = UI.qrAs || "u-c1";
  const url = `${location.origin}/?join=${S.sandbox}&as=${as}`;
  let qr = "";
  try { const q = qrcode(0, "M"); q.addData(url); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch (e) { qr = ""; }
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><div><div class="caps">This demo</div><h2 style="margin-top:6px;font-size:30px">Open on your phone</h2></div>${closeX}</div>
    <p class="muted" style="margin:8px 0 0">Scan with your phone's camera. It joins this same demo, so changes here appear there instantly.</p>
    <div class="field" style="margin-top:16px"><label for="qr-as">Sign the phone in as</label><select class="input" id="qr-as">${META.demoUsers.filter((u) => u.role === "clinician").map((u) => `<option value="${u.id}" ${u.id === as ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></div>
    ${qr ? `<div class="qr">${qr}</div>` : `<p class="err">The QR code couldn't load. Use the code below instead.</p>`}
    <div class="code">${esc(S.sandbox)}</div>
    <p class="muted" style="text-align:center;font-size:13px;margin:6px 0 0">Or open <span class="mono">${esc(location.host)}</span> and enter this code.</p>`;
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
  UI.rec = await api("GET", "/api/patients/" + id); UI.pid = id;
  const a = S.appts.find((x) => x.id === apptId);
  if (a && a.moved && !a.seen) { a.seen = true; api("POST", "/api/appointments/" + a.id + "/seen").catch(() => {}); }
  render();
  const sc = $("#ph-scroll"); if (sc) sc.scrollTop = 0; window.scrollTo(0, 0);
}
async function switchRole(admin) {
  if (!S || isAdmin() === admin) return;
  closeDrawer();
  await signIn(admin ? "u-admin" : UI.lastClin, S.sandbox);
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act;
  try {
    switch (act) {
      case "signin": el.disabled = true; await signIn(el.dataset.id); break;
      case "close": closeDrawer(); break;
      case "mode": await api("PUT", "/api/settings", { mode: el.dataset.v }); await load(); break;
      case "open-appt": openDrawer({ kind: "appt", id: el.dataset.id }); break;
      case "do-cancel": {
        el.disabled = true;
        const r = await api("POST", "/api/appointments/" + el.dataset.id + "/cancel", { reason: $("#reason").value });
        if (!isAdmin()) { closeDrawer(); UI.pid = null; UI.rec = null; toast("Visit cancelled. The office system is refilling the slot."); await load(); break; }
        UI.flow = flowFrom(r); openDrawer({ kind: "flow" }); refetch(); break;
      }
      case "patient-cancel": el.disabled = true; closeDrawer(); await api("POST", "/api/demo/sms", { patientId: el.dataset.id, body: "CANCEL" }); break;
      case "reply": el.disabled = true; await api("POST", "/api/demo/sms", { patientId: el.dataset.p, body: el.dataset.v }); break;
      case "see-clin": UI.lastClin = "u-" + el.dataset.c; closeDrawer(); await signIn(UI.lastClin, S.sandbox); window.scrollTo(0, 0); break;
      case "add-wl": openDrawer({ kind: "wl" }); break;
      case "tab": UI.tab = el.dataset.v; UI.pid = null; UI.rec = null; render(); break;
      case "open-p": await openPatient(el.dataset.id, el.dataset.appt); break;
      case "back": UI.pid = null; UI.rec = null; render(); break;
      case "chip": { const n = $(`#note-${UI.pid}`); n.value = (n.value ? n.value.replace(/[\s.]*$/, "") + ". " : "") + el.textContent; n.focus(); break; }
      case "focus-note": { const n = $(`#note-${UI.pid}`); n.scrollIntoView({ behavior: "smooth", block: "center" }); n.focus({ preventScroll: true }); break; }
      case "save-note": {
        const n = $(`#note-${el.dataset.id}`), v = n.value.trim();
        if (!v) { toast("Write a note first", true); n.focus(); break; }
        await api("POST", "/api/patients/" + el.dataset.id + "/notes", { body: v });
        n.value = ""; await load(); toast("Saved to " + UI.rec.name + "'s record"); break;
      }
      case "copy": { const v = el.dataset.v; try { await navigator.clipboard.writeText(v); toast("Number copied: " + v); } catch (err) { toast(v); } break; }
      case "status": {
        const v = el.dataset.v, n = UI.pid ? $(`#note-${UI.pid}`) : null, note = n ? n.value.trim() : "";
        if (v === "done" && note) { await api("POST", "/api/patients/" + UI.pid + "/notes", { body: note }); n.value = ""; }
        await api("POST", "/api/appointments/" + el.dataset.id + "/status", { status: v });
        toast(v === "enroute" ? "Patient texted that you're on the way" : v === "live" ? "Visit started" : "Visit complete. On to the next one.");
        if (v === "done") { UI.pid = null; UI.rec = null; }
        await load(); break;
      }
    }
  } catch (err) { fail(err); el.disabled = false; }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (e.target.id === "wl-form") {
      await api("POST", "/api/waitlist", { patientId: $("#wl-p").value, name: $("#wl-name").value, pc: $("#wl-pc").value, addr: $("#wl-addr").value, phone: $("#wl-phone").value, type: $("#wl-type").value, prio: $("#wl-prio").value, avail: $("#wl-avail").value, shortNotice: $("#wl-short").value === "1" });
      closeDrawer(); await load(); toast("Added to the waiting list");
    }
    if (e.target.id === "join-form") {
      const code = $("#join-code").value.trim().toUpperCase();
      if (code.length !== 6) { toast("Demo codes are 6 characters, shown on the office screen", true); return; }
      await signIn($("#join-as").value, code);
    }
  } catch (err) { fail(err); }
});
document.addEventListener("change", async (e) => {
  try {
    if (e.target.id === "wl-p") $("#wl-new").hidden = e.target.value !== "new";
    if (e.target.id === "offer-min") { await api("PUT", "/api/settings", { offerMinutes: Number(e.target.value) }); await load(); toast("Normal reply window: " + e.target.value + " min"); }
    if (e.target.id === "fee") { const v = Math.max(0, Math.round(Number(e.target.value) || 0)); await api("PUT", "/api/settings", { fee: v }); await load(); toast("Fee set to " + money(v) + " per visit"); }
    if (e.target.id === "me") { UI.lastClin = e.target.value; await signIn(e.target.value, S.sandbox); }
    if (e.target.id === "qr-as") { UI.qrAs = e.target.value; renderDrawer(); }
  } catch (err) { fail(err); }
});
document.addEventListener("input", (e) => { if (e.target.id === "psearch") { UI.q = e.target.value; render(); } });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && UI.drawer) closeDrawer(); });
$("#role-admin").onclick = () => switchRole(true).catch(fail);
$("#role-clin").onclick = () => switchRole(false).catch(fail);
$("#open-phone").onclick = () => openDrawer({ kind: "qr" });
$("#reset").onclick = async () => {
  try {
    if (!isAdmin()) await signIn("u-admin", S.sandbox);
    await api("POST", "/api/admin/reset"); closeDrawer(); UI.pid = null; UI.rec = null; await load(); toast("Demo started again from 10:20");
  } catch (err) { fail(err); }
};

(async function boot() {
  try { META = await api("GET", "/api/meta"); }
  catch (e) { $("#app").innerHTML = `<div class="shell"><div class="err">Can't reach the server. Start it with <span class="mono">npm start</span> and reload.</div></div>`; return; }
  const params = new URLSearchParams(location.search);
  if (params.get("join")) {
    history.replaceState(null, "", "/");
    try { await signIn(params.get("as") || "u-c1", params.get("join")); return; } catch (e) { fail(e); }
  }
  if (TOKEN) { try { await load(); connect(); return; } catch (e) { setToken(null); } }
  S = null; render();
})();
})();
