import test from "node:test";
import assert from "node:assert/strict";
import { isFakeIP, parseNetworkQuality } from "../src/net-speed.mjs";

test("isFakeIP detects Clash/Surge benchmark range", () => {
  assert.equal(isFakeIP("198.18.2.28"), true);
  assert.equal(isFakeIP("198.19.0.1"), true);
  assert.equal(isFakeIP("104.16.132.229"), false);
  assert.equal(isFakeIP(null), false);
});

test("parseNetworkQuality maps bits/s and latency", () => {
  const result = parseNetworkQuality(JSON.stringify({
    dl_throughput: 875_857_728,
    ul_throughput: 675_905_472,
    base_rtt: 59.13,
    dl_bytes_transferred: 1_132_371_164,
    ul_bytes_transferred: 1_111_490_560,
    il_h2_req_resp: [44, 50, 55],
    test_endpoint: "hkhkg1-edge-fx-022.aaplimg.com",
    interface_name: "en7",
    dl_phase_duration: 12.3,
    ul_phase_duration: 16.6,
  }));
  assert.equal(result.downloadMbps, 875.857728);
  assert.equal(result.uploadMbps, 675.905472);
  assert.equal(result.pingMs, 59.13);
  assert.ok(Math.abs(result.jitterMs - 5.5) < 0.001);
  assert.equal(result.endpoint, "hkhkg1-edge-fx-022.aaplimg.com");
  assert.equal(result.dlBytes, 1_132_371_164);
});
