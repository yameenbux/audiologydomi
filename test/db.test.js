"use strict";
// Fails the build if this Node version can't load node:sqlite, instead of crashing after deploy.
const test = require("node:test");
const assert = require("node:assert");

test("a sandbox database opens and seeds the demo data", () => {
  const { openDb } = require("../server/db");
  const db = openDb();
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM clinicians").get().n, 3);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE source = 'list'").get().n, 6);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM recalls").get().n, 4, "recalls due, also in the refill pool");
});

test("the database certificate is read however it was pasted: without line breaks, or without its BEGIN and END lines", () => {
  const { pemOf } = require("../server/pgstore");
  const crypto = require("node:crypto");
  const pem = `-----BEGIN CERTIFICATE-----\nMIIBgzCCASmgAwIBAgIUBeZ1zNGdFqLpg75drAe+GlQnH/owCgYIKoZIzj0EAwIw\nFzEVMBMGA1UEAwwMRG9taSB0ZXN0IENBMB4XDTI2MTAxODEzMzQyNloXDTM2MTAx\nNTEzMzQyNlowFzEVMBMGA1UEAwwMRG9taSB0ZXN0IENBMFkwEwYHKoZIzj0CAQYI\nKoZIzj0DAQcDQgAEWNNSDVUdCiXOrFm/6eEDHnqjpQ764Bw8NOw1bhmzt+sqZgRx\nNzQlfzUHHYVUvsE0yRAVlDTYjuCaWFrVLUSLlaNTMFEwHQYDVR0OBBYEFBZX6iFa\ng6u26OHUrqCgjoOpviPYMB8GA1UdIwQYMBaAFBZX6iFag6u26OHUrqCgjoOpviPY\nMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgGyvGwkKXYy6sZM9O\nWFfWcuKypXAmKxiGTOyy2eYDlBoCIQD1Wvy9pSsFIrbJi0Y0nv6Nmtp1hSUShpyY\n0/xjfEU0+Q==\n-----END CERTIFICATE-----\n`;
  const fp = new crypto.X509Certificate(pem).fingerprint256;
  for (const pasted of [pem, pem.replace(/\n/g, ""), pem.replace(/\n/g, " "), "MIIBgzCCASmgAwIBAgIUBeZ1zNGdFqLpg75drAe+GlQnH/owCgYIKoZIzj0EAwIwFzEVMBMGA1UEAwwMRG9taSB0ZXN0IENBMB4XDTI2MTAxODEzMzQyNloXDTM2MTAxNTEzMzQyNlowFzEVMBMGA1UEAwwMRG9taSB0ZXN0IENBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWNNSDVUdCiXOrFm/6eEDHnqjpQ764Bw8NOw1bhmzt+sqZgRxNzQlfzUHHYVUvsE0yRAVlDTYjuCaWFrVLUSLlaNTMFEwHQYDVR0OBBYEFBZX6iFag6u26OHUrqCgjoOpviPYMB8GA1UdIwQYMBaAFBZX6iFag6u26OHUrqCgjoOpviPYMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgGyvGwkKXYy6sZM9OWFfWcuKypXAmKxiGTOyy2eYDlBoCIQD1Wvy9pSsFIrbJi0Y0nv6Nmtp1hSUShpyY0/xjfEU0+Q==", pem.replace(/\n/g, "\r\n")])
    assert.strictEqual(new crypto.X509Certificate(pemOf(pasted)).fingerprint256, fp, JSON.stringify(pasted.slice(0, 40)));
  assert.strictEqual((pemOf(pem + pem).match(/BEGIN CERTIFICATE/g) || []).length, 2, "a chain stays a chain");
  assert.strictEqual(pemOf(""), null);
});
