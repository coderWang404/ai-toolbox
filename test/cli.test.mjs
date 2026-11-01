import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, "bin/ai-toolbox.mjs");
const sqlite = await which("sqlite3");

async function which(name) {
  const dirs = (process.env.PATH || "").split(":");
  for (const dir of dirs) {
    try {
      await execFileAsync("test", ["-x", path.join(dir, name)]);
      return path.join(dir, name);
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "ai-toolbox-test-"));
  const cc = path.join(home, ".cc-switch");
  const codex = path.join(home, ".codex");
  await mkdir(cc, { recursive: true });
  await mkdir(codex, { recursive: true });
  await writeFile(path.join(codex, "config.toml"), 'model_provider = "alpha"\nmodel = "m1"\n\n[model_providers.alpha]\nbase_url = "https://alpha.example/v1"\nexperimental_bearer_token = "sk-alpha-secret-123456"\n');
  await writeFile(path.join(cc, "settings.json"), JSON.stringify({ currentProviderCodex: "alpha" }));
  await execFileAsync(sqlite, [path.join(cc, "cc-switch.db"), `
    CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
      settings_config TEXT NOT NULL, website_url TEXT, category TEXT, created_at INTEGER,
      sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT, meta TEXT NOT NULL DEFAULT '{}',
      is_current BOOLEAN NOT NULL DEFAULT 0, in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
      cost_multiplier TEXT NOT NULL DEFAULT '1.0', limit_daily_usd TEXT, limit_monthly_usd TEXT,
      provider_type TEXT, PRIMARY KEY (id, app_type));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `]);
  const alpha = {
    auth: { OPENAI_API_KEY: "sk-alpha-secret-123456" },
    config: 'model_provider = "alpha"\nmodel = "m1"\n\n[model_providers.alpha]\nname = "Alpha"\nbase_url = "https://alpha.example/v1"\n',
    modelCatalog: { models: [{ model: "m1" }, { model: "m2" }] },
  };
  const beta = {
    auth: { OPENAI_API_KEY: "sk-beta-secret-abcdef" },
    config: 'model_provider = "beta"\nmodel = "m2"\n\n[model_providers.beta]\nname = "Beta"\nbase_url = "https://beta.example/v1"\n',
  };
  const insert = (id, name, settings, current) => `INSERT INTO providers (id,app_type,name,settings_config,meta,is_current,sort_index) VALUES ('${id}','codex','${name}','${JSON.stringify(settings).replaceAll("'", "''")}','{}',${current ? 1 : 0},1);`;
  await execFileAsync(sqlite, [path.join(cc, "cc-switch.db"), insert("alpha", "Alpha", alpha, 1) + insert("beta", "Beta", beta, 0)]);
  return { home, cc, codex, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function envFor(f) {
  return {
    ...process.env,
    HOME: f.home,
    CODEX_HOME: f.codex,
    AI_TOOLBOX_USER_REMOTES: path.join(f.home, ".ai-toolbox", "remotes.json"),
  };
}

test("CLI list redacts secrets unless --with-secrets", { skip: !sqlite }, async () => {
  const f = await fixture();
  try {
    const normal = JSON.parse((await execFileAsync(process.execPath, [BIN, "list", "--json"], { env: envFor(f) })).stdout);
    assert.equal(normal.ok, true);
    assert.equal(normal.providers.length, 2);
    assert.ok(normal.providers.every((item) => item.token === null));
    assert.equal(normal.providers[0].tokenTail, "t-123456");

    const secret = JSON.parse((await execFileAsync(process.execPath, [BIN, "list", "--json", "--with-secrets"], { env: envFor(f) })).stdout);
    assert.equal(secret.providers[0].token, "sk-alpha-secret-123456");
  } finally {
    await f.cleanup();
  }
});

test("switch dry-run does not write the catalog file", { skip: !sqlite }, async () => {
  const f = await fixture();
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [BIN, "switch", "alpha", "--dry-run", "--force", "--json"],
      { env: envFor(f) },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.match(result.preview, /model_providers\.alpha/);
    const fs = await import("node:fs/promises");
    await assert.rejects(fs.access(path.join(f.codex, "cc-switch-model-catalog.json")));
  } finally {
    await f.cleanup();
  }
});

test("CLI error contract: exit 1 with ok:false JSON", { skip: !sqlite }, async () => {
  const f = await fixture();
  try {
    let error;
    try {
      await execFileAsync(process.execPath, [BIN, "switch", "missing", "--force", "--json"], { env: envFor(f) });
    } catch (err) {
      error = err;
    }
    assert.ok(error, "should fail");
    assert.equal(error.code, 1);
    const payload = JSON.parse(error.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /找不到供应商/);
  } finally {
    await f.cleanup();
  }
});

test("go-keys redacts full key by default", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ai-toolbox-go-"));
  try {
    await mkdir(path.join(home, ".ai-toolbox"), { recursive: true });
    await writeFile(path.join(home, ".ai-toolbox", "opencode-go-keys.json"), JSON.stringify({
      keys: [{ id: "1", name: "k", key: "sk-1234567890abcdef", plan: "go" }],
    }));
    const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex") };
    const normal = JSON.parse((await execFileAsync(process.execPath, [BIN, "go-keys", "--json"], { env })).stdout);
    assert.equal(normal.keys[0].key, undefined);
    assert.equal(normal.keys[0].tail, "cdef");
    const secret = JSON.parse((await execFileAsync(process.execPath, [BIN, "go-keys", "--json", "--with-secrets"], { env })).stdout);
    assert.equal(secret.keys[0].key, "sk-1234567890abcdef");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
