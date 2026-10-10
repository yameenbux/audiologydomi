"use strict";
// Routing with a fake network: postcodes.io lookups, OSRM tables, outages and unknown postcodes.
const test = require("node:test");
const assert = require("node:assert");
const travel = require("../server/travel");

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
function fakeNetwork({ down = false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(url);
    if (down) throw new Error("connect ETIMEDOUT");
    if (url.endsWith("/postcodes")) {
      const { postcodes } = JSON.parse(init.body);
      return json({ status: 200, result: postcodes.map((q) => ({ query: q, result: q === "LS7 3ZZ" ? null : { latitude: 53.83, longitude: -1.53 } })) });
    }
    const n = new URL(url).pathname.split("/").pop().split(";").length;
    // 10 minutes between every pair
    return json({ code: "Ok", durations: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : 600))) });
  };
  return { fetch, calls };
}
test.afterEach(() => { travel._reset(); travel.configure({ provider: "estimate", fetch: (...a) => fetch(...a) }); });

test("postcodes are tidied up, and districts still work", () => {
  assert.strictEqual(travel.normalise(" ls64dh "), "LS6 4DH");
  assert.strictEqual(travel.normalise("ls16"), "LS16");
  assert.ok(travel.isFull("LS17 7LH") && !travel.isFull("LS17"));
  assert.ok(travel.known("LS16") && !travel.known("M1"));
});

test("the sample diary's postcodes use saved road routes", () => {
  const d = travel.driveInfo("LS6 4DH", "LS17 7LH");
  assert.strictEqual(d.source, "road");
  assert.ok(d.min >= 10 && d.min <= 25, `about a quarter of an hour across north Leeds, got ${d.min}`);
  assert.strictEqual(travel.driveInfo("LS6", "LS17").source, "estimate", "districts alone can't be routed");
});

test("a new full postcode is looked up and routed by road, once", async () => {
  const net = fakeNetwork();
  travel.configure({ provider: "osrm", fetch: net.fetch });
  await travel.prepare(["LS7 3AB", "LS6 4DH", "LS17 7LH"]);
  assert.deepStrictEqual(travel.driveInfo("LS7 3AB", "LS6 4DH"), { min: 17, source: "road" }, "10 min by road, plus traffic and parking");
  const before = net.calls.length;
  await travel.prepare(["LS7 3AB", "LS6 4DH"]);
  assert.strictEqual(net.calls.length, before, "cached: no second request");
});

test("a postcode that doesn't exist is rejected", async () => {
  travel.configure({ provider: "osrm", fetch: fakeNetwork().fetch });
  await travel.prepare(["LS7 3ZZ"]);
  assert.strictEqual(travel.known("LS7 3ZZ"), false);
});

test("if the router is down, estimates are used and it isn't asked again for a while", async () => {
  const net = fakeNetwork({ down: true });
  travel.configure({ provider: "osrm", fetch: net.fetch });
  await travel.prepare(["LS7 3AB", "LS6 4DH"]); // must not throw
  assert.strictEqual(travel.driveInfo("LS7 3AB", "LS6 4DH").source, "estimate");
  assert.ok(travel.known("LS7 3AB"), "still bookable on its district");
  const s = travel.routingStatus();
  assert.ok(s.paused && /ETIMEDOUT/.test(s.lastError.message));
  const before = net.calls.length;
  await travel.prepare(["LS8 1AA", "LS6 4DH"]);
  assert.strictEqual(net.calls.length, before, "paused after a failure");
});

test("with routing off, nothing goes over the network", async () => {
  const net = fakeNetwork();
  travel.configure({ provider: "estimate", fetch: net.fetch });
  await travel.prepare(["LS7 3AB", "LS6 4DH"]);
  assert.strictEqual(net.calls.length, 0);
});
