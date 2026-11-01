import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderConfig } from "../src/switcher.mjs";

test("live app sections replace stale provider snapshots", () => {
  const provider = {
    id: "p",
    name: "P",
    config: `model_provider = "p"
model = "m"

[model_providers.p]
base_url = "https://example.com"

[desktop]
locale = "en"
old = 1

[plugins]
stale = true
`,
    auth: { OPENAI_API_KEY: "sk-test-123456789" },
    meta: {},
  };
  const live = `[desktop]
locale = "zh"

[projects."/tmp/x"]
trust_level = "trusted"
`;
  const { text } = buildProviderConfig({
    provider,
    commonConfig: null,
    apiFormat: null,
    liveConfigText: live,
    dryRun: true,
  });
  assert.match(text, /\[desktop\]\nlocale = "zh"/);
  assert.equal(text.includes("old = 1"), false);
  assert.equal(text.includes("stale = true"), false);
  assert.match(text, /\[projects\."\/tmp\/x"\]/);
  assert.match(text, /experimental_bearer_token = "sk-test-123456789"/);
});
