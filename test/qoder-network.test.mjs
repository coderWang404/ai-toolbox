import test from "node:test";
import assert from "node:assert/strict";
import {
  DOMAINS,
  HOSTS_MARKER,
  LIVE_IP,
  ensureMerge,
  ensureRules,
  hostsWithBlock,
  parseProfiles,
  parseRemoteProbe,
} from "../src/qoder-network.mjs";

test("hosts block is added and removed without touching other lines", () => {
  const base = "127.0.0.1 localhost\n10.0.0.1 router\n";
  const added = hostsWithBlock(base, LIVE_IP, true);
  assert.match(added, new RegExp(HOSTS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const domain of DOMAINS) assert.match(added, new RegExp(`${LIVE_IP} ${domain.replace(/\./g, "\\.")}`));
  const removed = hostsWithBlock(added, LIVE_IP, false);
  assert.equal(removed.includes(HOSTS_MARKER), false);
  assert.equal(removed.includes("127.0.0.1 localhost"), true);
  assert.equal(removed.includes("10.0.0.1 router"), true);
});

test("rules are prepended once and can be removed", () => {
  const base = "prepend:\n  - DOMAIN-SUFFIX,example.com,DIRECT\n\nappend: []\n";
  const added = ensureRules(base, true);
  assert.match(added, /IP-CIDR,8\.153\.206\.47\/32,DIRECT,no-resolve/);
  assert.match(added, /DOMAIN-SUFFIX,qoder\.com\.cn,DIRECT/);
  assert.equal(added.match(/DOMAIN-SUFFIX,qoder\.com\.cn,DIRECT/g).length, 1);
  const idempotent = ensureRules(added, true);
  assert.equal(idempotent, added);
  const removed = ensureRules(added, false);
  assert.equal(removed.includes("qoder.com.cn"), false);
  assert.match(removed, /example\.com/);
});

test("rules handle inline empty prepend", () => {
  const added = ensureRules("prepend: []\nappend: []\n", true);
  assert.match(added, /prepend:\n  - IP-CIDR/);
});

test("merge adds and removes dns/hosts keys", () => {
  const base = "# template\n\ndns:\n  use-system-hosts: false\n\nhosts:\n  \"example.com\": \"1.2.3.4\"\n";
  const added = ensureMerge(base, true);
  assert.match(added, /use-system-hosts: true/);
  assert.match(added, /use-hosts: true/);
  assert.match(added, /"gateway\.qoder\.com\.cn": "8\.153\.206\.47"/);
  assert.match(added, /"example\.com": "1\.2\.3\.4"/);
  const removed = ensureMerge(added, false);
  assert.equal(removed.includes("use-system-hosts"), false);
  assert.equal(removed.includes("use-hosts"), false);
  assert.equal(removed.includes("qoder.com.cn"), false);
  assert.match(removed, /example\.com/);
});

test("parseProfiles finds current remote and enhancement ids", () => {
  const parsed = parseProfiles(`current: R1
items:
- uid: Merge
  type: merge
  file: Merge.yaml
- uid: R1
  type: remote
  name: Test
  file: R1.yaml
  selected:
  - name: node
    now: UK
  option:
    merge: M1
    rules: RU1
`);
  assert.equal(parsed.current, "R1");
  assert.equal(parsed.items.find((item) => item.uid === "R1")?.node, "UK");
  assert.equal(parsed.items.find((item) => item.uid === "R1")?.rules, "RU1");
  assert.equal(parsed.items.find((item) => item.uid === "R1")?.merge, "M1");
});

test("parseRemoteProbe reads direct and proxy endpoint paths", () => {
  const probe = parseRemoteProbe(`HOSTNAME=sr650
USER=wangyiming
HOSTS_COUNT=4
ENV=QODERCN_HTTPDNS=false
INSTALLS=2
WRAPPED=2
WRAPPER_PROXY=export HTTPS_PROXY=http://127.0.0.1:18443
WRAPPER_ENV=export QODERCN_HTTPDNS=false
WATCHER=active
PROXY_SERVICE=active
PROXY_PORT=1
RUNTIME=0
ENDPOINT_DIRECT=200|0.15
ENDPOINT_PROXY=000|6.0
`);
  assert.equal(probe.hostname, "sr650");
  assert.equal(probe.installs, 2);
  assert.equal(probe.wrapped, 2);
  assert.equal(probe.hostsCount, 4);
  assert.equal(probe.watcher, "active");
  assert.equal(probe.endpointDirectCode, 200);
  assert.equal(probe.endpointDirectTimeMs, 150);
  assert.equal(probe.endpointProxyCode, 0);
});
