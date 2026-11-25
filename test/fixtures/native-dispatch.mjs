import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixturePng } from "./image-service.mjs";

const dir = process.cwd();
assert.equal(dir, process.env.OPENCLAW_STATE_DIR);
assert.equal(await readFile(join(dir, ".owner"), "utf8"), String(process.ppid));
const root = process.env.OPENCLAW_TEST_ROOT;
assert.equal(JSON.parse(await readFile(join(root, "package.json"))).version, "2026.11.7");
const dist = join(root, "dist");
const host = name => import(pathToFileURL(join(dist, name)).href);
const id = "github-copilot-image";
const workRoot = join(dir, "jobs");
const workspace = join(dir, "workspace");
const cliPath = join(dir, "service.js");
await mkdir(workRoot, { mode: 0o700 });
await mkdir(workspace);
await writeFile(cliPath, `#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { serveImageFixture } from ${JSON.stringify(new URL("image-service.mjs", import.meta.url).href)};
serveImageFixture(async ({ name, arguments: args }) => {
  assert.equal(name, "image_generation");
  const references = [];
  for (const { path } of args.input_images ?? []) {
    assert.equal(dirname(path), process.cwd());
    references.push((await readFile(path)).toString("base64"));
  }
  await appendFile(join(import.meta.dirname, "receipts.jsonl"), JSON.stringify({ prompt: args.prompt, references }) + "\\n");
});\n`, { mode: 0o700 });
await writeFile(join(dir, "receipts.jsonl"), "");
const config = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
config.agents = { defaults: { workspace, mediaModels: { image: { primary: "github-copilot/image-generation", fallbacks: [] } } } };
config.plugins = { ...config.plugins, allow: [id], entries: { [id]: { enabled: true,
  config: { workRoot, expectedLogin: "fixture", cliPath } } } };
await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
const { setRuntimeConfigSnapshot } = await host("plugin-sdk/runtime-config-snapshot.js");
setRuntimeConfigSnapshot(config);
const { loadOpenClawPluginsAsync } = await host("plugins/loader.js");
const registry = await loadOpenClawPluginsAsync({ config, onlyPluginIds: [id], workspaceDir: workspace, cache: false });
assert.equal(registry.plugins.find(p => p.id === id)?.status, "loaded");
assert.equal(registry.typedHooks.length, 0);
assert.equal(registry.imageGenerationProviders.length, 1);
const bundles = (await readdir(dist)).filter(name => /^openclaw-tools-\w+\.mjs$/.test(name));
const modules = await Promise.all(bundles.map(host));
const { createOpenClawToolsAsync } = modules.find(bundle => typeof bundle.createOpenClawToolsAsync === "function");
const tools = await createOpenClawToolsAsync({ config, workspaceDir: workspace });
const tool = tools.find(value => value.name === "image_generate");
assert.ok(tool, "Stock image_generate should be available");
const refA = join(workspace, "red.png"), refB = join(workspace, "blue.png");
const secondPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPjfAAACgwGAQ7v4AwAAAABJRU5ErkJggg==";
await writeFile(refA, Buffer.from(fixturePng, "base64"));
await writeFile(refB, Buffer.from(secondPng, "base64"));
const create = await tool.execute("stock-create", { prompt: "Make a blue circle." });
const edit = await tool.execute("stock-edit", { prompt: "Combine these two drawings.", images: [refA, refB] });
for (const result of [create, edit]) {
  assert.equal(result.details.provider, "github-copilot", JSON.stringify(result.details));
  assert.equal(result.details.model, "image-generation");
  const [path] = result.details.media.mediaUrls;
  assert.equal((await readFile(path)).toString("base64"), fixturePng);
}
const receipts = (await readFile(join(dir, "receipts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
assert.deepEqual(receipts.map(({ prompt, references }) => [prompt, references]), [
  ["Make a blue circle.", []], ["Combine these two drawings.", [fixturePng, secondPng]],
]);
