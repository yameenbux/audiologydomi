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
test.afterEach(() => { travel._reset(); travel.configure({ provider: "estimate", orsKey: "", fetch: (...a) => fetch(...a) }); });

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

test("openrouteservice: one matrix for the stops, road times and road miles cached, daily allowance respected", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/postcodes")) {
      const { postcodes } = JSON.parse(init.body);
      return json({ status: 200, result: postcodes.map((q, i) => ({ query: q, result: { latitude: 53.5 + i / 100, longitude: -2.4 } })) });
    }
    if (url.endsWith("/v2/matrix/driving-car")) {
      const { locations, metrics } = JSON.parse(init.body);
      assert.deepStrictEqual(metrics, ["duration", "distance"]);
      const n = locations.length;
      return json({ durations: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : 900))), distances: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : 16.09))) });
    }
    return json({ features: [{ geometry: { coordinates: [[-2.4, 53.5], [-2.41, 53.51]] } }] });
  };
  travel.configure({ provider: "ors", orsKey: "test-key", fetch });
  await travel.prepare(["BL1 4AB", "BL3 6RT", "WN6 7QA"]);
  const m = calls.filter((c) => c.url.endsWith("/v2/matrix/driving-car"));
  assert.strictEqual(m.length, 1, "one table for all three");
  assert.strictEqual(m[0].init.headers.Authorization, "test-key");
  assert.ok(!m[0].init.body.includes("BL1"), "only coordinates are sent, never the postcode or a name");
  const d = travel.driveInfo("BL1 4AB", "WN6 7QA");
  assert.strictEqual(d.source, "road");
  assert.strictEqual(d.min, Math.round(15 * 1.3) + 4, "15 min by road, plus traffic and parking");
  assert.strictEqual(travel.miles("BL1 4AB", "WN6 7QA"), 10, "16.09 km by road is 10 miles");
  await travel.prepare(["BL1 4AB", "BL3 6RT", "WN6 7QA"]);
  assert.strictEqual(calls.filter((c) => c.url.endsWith("/v2/matrix/driving-car")).length, 1, "cached: not asked twice");
  assert.ok(await travel.roadPath(["BL1 4AB", "BL3 6RT"]));
  const st = travel.routingStatus();
  assert.match(st.provider, /openrouteservice/); assert.match(st.credit, /HeiGIT/);
  assert.strictEqual(st.usedToday.matrix, 1); assert.strictEqual(st.usedToday.directions, 1);
});

test("openrouteservice without a key, or with its daily allowance used up, falls back to estimates", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => { calls.push(url); if (url.endsWith("/postcodes")) return json({ status: 200, result: JSON.parse(init.body).postcodes.map((q) => ({ query: q, result: { latitude: 53.6, longitude: -2.5 } })) }); return json({ durations: [[0, 600], [600, 0]] }); };
  travel.configure({ provider: "ors", orsKey: "", fetch });
  await travel.prepare(["BL1 1AA", "BL2 2BB"]);
  assert.strictEqual(calls.length, 0, "no key: nothing is sent anywhere");
  assert.strictEqual(travel.routingStatus().live, false);
  travel.configure({ orsKey: "k" });
  for (let i = 0; i < 460; i++) await travel.prepare([`BL1 ${i % 10}AA`.replace(/ (\d)AA/, " $1AA"), `BL9 ${i % 10}ZZ`, `OL${i} 1AA`]);
  assert.ok(travel.routingStatus().usedToday.matrix <= 450, "stops short of the 500 a day");
});
