"use strict";
// Live events over Server-Sent Events, scoped to one sandbox. Office users see everything in their
// sandbox; a clinician only events about their own round. Events raised inside a transaction are held
// until it commits, so screens never show a change that was rolled back.
const sandbox = require("./sandbox");

const clients = new Set();
const recent = new Map(); // sandbox id → last 100 events
let seq = 0;

function deliver(sbId, e) {
  const list = recent.get(sbId) || [];
  list.unshift(e);
  list.length = Math.min(list.length, 100);
  recent.set(sbId, list);
  for (const c of clients) {
    if (c.sbId !== sbId) continue;
    if (c.user.role === "admin" || e.type === "reset" || (e.clinicianId && e.clinicianId === c.user.clinicianId)) {
      c.res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    }
  }
}

function emit(evt) {
  const sb = sandbox.current();
  const e = { id: ++seq, at: sandbox.stamp(sb), ...evt };
  if (sb.pending) sb.pending.events.push(() => deliver(sb.id, e));
  else deliver(sb.id, e);
}

function subscribe(res, user, sbId) {
  const c = { res, user, sbId };
  clients.add(c);
  res.on("close", () => clients.delete(c));
}

const recentFor = (sbId) => recent.get(sbId) || [];
const connections = (sbId) => [...clients].filter((c) => c.sbId === sbId).length;

module.exports = { emit, subscribe, recentFor, connections };
