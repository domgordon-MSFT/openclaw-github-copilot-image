import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the installed Copilot provider runs through stock image_generate", t => {
  const root = process.env.OPENCLAW_TEST_ROOT;
  assert.ok(root && isAbsolute(root), "Set OPENCLAW_TEST_ROOT to the stock 2026.11.7 npm package");
  const dir = mkdtempSync(join(tmpdir(), "oc-stock-image-turn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  writeFileSync(join(dir, ".owner"), String(process.pid), { flag: "wx" });
  const env = Object.fromEntries(["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR"]
    .filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir,
    OPENCLAW_HOME: dir, OPENCLAW_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: join(dir, "config.json"), OPENCLAW_TEST_ROOT: root });
  assert.ok(process.env.npm_execpath, "Run npm run test:package");
  const run = (args, cwd) => {
    const child = spawnSync(process.execPath, args, { env, cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  };
  const [archive] = JSON.parse(run([process.env.npm_execpath, "pack", "--json", "--ignore-scripts", "--pack-destination", dir],
    fileURLToPath(new URL("../", import.meta.url))));
  assert.ok(archive.files.some(f => f.path === "index.mjs"));
  assert.ok(!archive.files.some(f => f.path === "stock-ingress.mjs"));
  assert.ok(!archive.files.some(f => f.path.startsWith("test/")));
  writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}");
  run([join(root, "dist", "index.js"), "plugins", "install", "--force", "--no-enable", "--accept-capabilities",
    `npm-pack:${join(dir, archive.filename)}`], dir);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/native-dispatch.mjs", import.meta.url))],
    { env, cwd: dir, stdio: "inherit", timeout: 150_000 });
  if (child.error) throw child.error;
  assert.equal(child.status, 0);
});
