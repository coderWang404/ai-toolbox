import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProviderSlice,
  mergeRemotes,
  normalizeHost,
  providerSnapshot,
  resolveRemotes,
  sshArgs,
  sshTarget,
} from "../src/remote-sync.mjs";
import { sshPythonArgs } from "../src/ccswitch-remote.mjs";

test("normalizeHost rejects ssh option injection", () => {
  assert.equal(normalizeHost("-oProxyCommand=evil"), null);
  assert.equal(normalizeHost({ host: "ok.example", user: "-root" }), null);
  assert.equal(normalizeHost({ host: "ok.example", user: "me" })?.user, "me");
});

test("providerSnapshot hides token by default", () => {
  const config = `model_provider = "x"
[model_providers.x]
name = "Provider"
base_url = "https://api.example.com/v1"
experimental_bearer_token = "sk-1234567890abcdef"
`;
  const snap = providerSnapshot(config);
  assert.equal(snap.token, null);
  assert.equal(snap.tokenTail, "90abcdef");
  assert.equal(providerSnapshot(config, { includeSecrets: true }).token, "sk-1234567890abcdef");
});

test("applyProviderSlice only replaces routing fields", () => {
  const remote = `model_provider = "old"
model = "old-model"
notify = ["say done"]

[model_providers.old]
name = "Old"

[projects."/tmp/x"]
trust_level = "trusted"
`;
  const local = `model_provider = "new"
model = "new-model"

[model_providers.new]
name = "New"
base_url = "https://new.example/v1"
`;
  const result = applyProviderSlice(remote, local);
  assert.match(result.text, /model_provider = "new"/);
  assert.match(result.text, /model = "new-model"/);
  assert.match(result.text, /\[model_providers\.new\]/);
  assert.equal(result.text.includes("[model_providers.old]"), false);
  assert.match(result.text, /notify = \["say done"\]/);
  assert.match(result.text, /\[projects\."\/tmp\/x"\]/);
  assert.equal(result.changed, true);
});

test("managed catalog pointer is translated to a remote-relative filename", () => {
  const remote = `model_provider = "old"
model = "old-model"
model_catalog_json = "cc-switch-model-catalog.json"

[model_providers.old]
name = "Old"
`;
  const local = `model_provider = "new"
model = "new-model"
model_catalog_json = "/Users/MacBook/.codex/cc-switch-model-catalog.json"

[model_providers.new]
name = "New"
base_url = "https://new.example/v1"
`;
  const { text } = applyProviderSlice(remote, local);
  assert.match(text, /model_catalog_json = "cc-switch-model-catalog\.json"/);
  assert.equal(text.includes("/Users/MacBook"), false);
});

test("catalog pointer inserted when remote has none", () => {
  const remote = `model_provider = "old"
model = "old-model"
`;
  const local = `model_provider = "new"
model = "new-model"
model_catalog_json = "/home/someone/.codex/cc-switch-model-catalog.json"

[model_providers.new]
name = "New"
base_url = "https://new.example/v1"
`;
  const { text } = applyProviderSlice(remote, local);
  assert.match(text, /model_catalog_json = "cc-switch-model-catalog\.json"/);
  assert.equal(text.includes("/home/someone"), false);
});

test("a user-managed catalog path is left untouched", () => {
  const remote = `model_provider = "old"
model = "old-model"
`;
  const local = `model_provider = "new"
model = "new-model"
model_catalog_json = "/Users/MacBook/.codex/my-own-catalog.json"

[model_providers.new]
name = "New"
base_url = "https://new.example/v1"
`;
  const { text } = applyProviderSlice(remote, local);
  assert.match(text, /model_catalog_json = "\/Users\/MacBook\/\.codex\/my-own-catalog\.json"/);
});

test("known machines get both addresses", () => {
  const lan = normalizeHost({ host: "183.175.14.217", label: "217" });
  assert.deepEqual(lan.altHosts, ["10.126.126.3"]);
  const et = normalizeHost({ host: "10.126.126.3", label: "3060ti" });
  assert.ok(et.altHosts.includes("183.175.14.217"));
  const h3c4090 = normalizeHost({ host: "183.175.14.230", label: "230" });
  assert.deepEqual(h3c4090.altHosts, ["10.126.126.5"]);
});

test("the same machine listed by both addresses is merged once", () => {
  const merged = mergeRemotes([], {
    disabled: [],
    hosts: [
      { host: "183.175.14.217", label: "217" },
      { host: "10.126.126.3", label: "3060ti" },
    ],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].host, "183.175.14.217");
});

test("resolveRemotes falls back to the EasyTier address", async () => {
  const entry = normalizeHost({ host: "183.175.14.217", label: "217" });
  const tried = [];
  const resolved = await resolveRemotes([entry], {
    useCache: false,
    probe: async (_entry, host) => {
      tried.push(host);
      return host === "10.126.126.3";
    },
  });
  assert.equal(resolved[0].resolvedHost, "10.126.126.3");
  assert.deepEqual(tried, ["183.175.14.217", "10.126.126.3"]);
});

test("sshArgs targets the resolved address", () => {
  const entry = normalizeHost({ host: "183.175.14.217", label: "217" });
  const args = sshArgs({ ...entry, resolvedHost: "10.126.126.3" }, "print(1)");
  assert.ok(args.some((arg) => arg === "10.126.126.3" || arg.endsWith("@10.126.126.3")));
  assert.equal(args.some((arg) => String(arg).includes("183.175.14.217")), false);
});

test("an alternate address inherits the primary host's ssh user", () => {
  const entry = normalizeHost({ host: "183.175.14.230", label: "230" });
  assert.equal(sshTarget(entry, "10.126.126.5", "tester"), "tester@10.126.126.5");
  assert.equal(sshTarget(entry, entry.host, "tester"), "183.175.14.230");
  const explicit = normalizeHost({ host: "183.175.14.219", label: "4080", user: "wangyiming" });
  assert.equal(sshTarget(explicit, "10.126.126.4", "other"), "wangyiming@10.126.126.4");
});

test("cc-switch sync dials the resolved address, not the LAN host", () => {
  const args = sshPythonArgs({
    host: "183.175.14.217",
    user: "server",
    resolvedHost: "10.126.126.3",
  });
  assert.ok(args.includes("server@10.126.126.3"));
  assert.equal(args.some((arg) => String(arg).includes("183.175.14.217")), false);
});
