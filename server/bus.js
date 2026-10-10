"use strict";
// In-process event bus feeding Server-Sent Events. Admins see everything; a clinician only their own round.
const clients = new Set();
const recent = [];
let seq = 0;

function emit(evt) {
  const e = { id: ++seq, at: new Date().toISOString(), ...evt };
  recent.unshift(e);
  recent.length = Math.min(recent.length, 100);
  for (const c of clients) {
    if (c.user.role === "admin" || e.type === "reset" || (e.clinicianId && e.clinicianId === c.user.clinicianId)) {
      c.res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    }
  }
}

function subscribe(res, user) {
  const c = { res, user };
  clients.add(c);
  res.on("close", () => clients.delete(c));
}

module.exports = { emit, subscribe, recent, clients };
