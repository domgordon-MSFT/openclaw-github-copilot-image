import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createCopilotImageAdapter } from "../copilot-adapter.mjs";
import { hostProfileAuth } from "../openclaw-profile.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DgAAAEQQFAjv0/EgAAAABJRU5ErkJggg==", "base64");
const image = { buffer: png, mimeType: "image/png" };
const descriptor = { name: "image_generation", input_schema: { properties: {
  prompt: { type: "string", maxLength: 32000 }, quality: { enum: ["low"] }, size: { enum: ["1024x1024"] },
  input_images: { type: "array", maxItems: 16, items: { oneOf: [
    { properties: { path: { type: "string" } }, required: ["path"] },
  ] } },
} } };

async function fixture(t, extra = {}) {
  const workRoot = await mkdtemp(join(tmpdir(), "copilot-sdk-test-"));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const sdk = { login: "image-user", tools: [descriptor], calls: [], sessions: [], stops: 0,
    result: { resultType: "success", binaryResultsForLlm: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] } };
  function client(options) {
    sdk.options = options;
    return {
      async start() { await sdk.onStart?.(); },
      getStatus: async () => ({ version: "1.0.114", protocolVersion: 4 }),
      getAuthStatus: async () => ({ isAuthenticated: true, login: sdk.login }),
      createSession: async config => {
        sdk.sessions.push(config);
        return { rpc: { tools: {
          async initializeAndValidate() {},
          getCurrentMetadata: async () => ({ tools: sdk.tools }),
          execute: async request => {
            sdk.calls.push(request);
            if (sdk.onExecute) await sdk.onExecute(request, config);
            return sdk.result;
          },
        } } };
      },
      stop: async () => { sdk.stops++; return sdk.stopErrors ?? []; },
      forceStop: async () => { sdk.onForceStop?.(); },
    };
  }
  const adapter = createCopilotImageAdapter({ cliPath: process.execPath, expectedLogin: "image-user", workRoot, ...extra }, client);
  return { sdk, adapter, workRoot };
}

test("one approved edit sends only the ordered reference files to the SDK, then removes them", async t => {
  const { sdk, adapter, workRoot } = await fixture(t);
  const references = [image, { buffer: Buffer.from([1, 2, 3]), mimeType: "image/jpeg" }];
  const job = { prompt: "Combine these two images", quality: "low", size: "1024x1024", references };
  sdk.onExecute = async ({ name, arguments: args, toolCallId }, config) => {
    assert.equal(name, "image_generation");
    assert.deepEqual(config.tools.availableTools, [name]);
    assert.equal(config.tools.imageGeneration.saveToDisk, false);
    const { input_images: inputs, ...text } = args;
    assert.deepEqual(text, { prompt: job.prompt, quality: job.quality, size: job.size });
    assert.equal(inputs.length, 2);
    for (const [i, { path }] of inputs.entries()) {
      assert.equal(dirname(path), config.workingDirectory);
      assert.deepEqual(await readFile(path), references[i].buffer);
    }
    const ask = config.permissions.onRequest;
    for (const other of [{ kind: "shell", toolName: name }, { kind: "custom-tool", toolName: "other" },
      { kind: "custom-tool", toolName: name, toolCallId: "other" },
      { kind: "custom-tool", toolName: name, toolCallId, args: { ...args, prompt: "Different image" } },
      { kind: "custom-tool", toolName: name, toolCallId, managedApprovalRequired: true }]) {
      assert.notEqual((await ask(other)).kind, "approve-once");
    }
    const permission = { kind: "custom-tool", toolName: name, toolCallId, args };
    assert.equal((await ask(permission)).kind, "approve-once");
    assert.notEqual((await ask(permission)).kind, "approve-once");
    const read = { kind: "read", path: inputs[0].path, toolCallId };
    for (const denied of [{ ...read, path: config.workingDirectory }, { ...read, toolCallId: "other" },
      { ...read, resolvedPath: join(config.workingDirectory, "other.png") },
      { ...read, managedApprovalRequired: true }, { ...read, requestSandboxBypass: true }]) {
      assert.equal((await ask(denied)).kind, "reject");
    }
    assert.equal((await ask(read)).kind, "approve-once");
    assert.equal((await ask(read)).kind, "reject");
    assert.equal((await ask({ kind: "read", path: inputs[1].path })).kind, "approve-once");
  };
  assert.deepEqual(await adapter.submitImage(job), image);
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.stops, 1);
  assert.deepEqual(await readdir(workRoot), []);
});

test("preflight uses the real contract but never executes an image tool or inherits provider tokens", async t => {
  const { sdk, adapter, workRoot } = await fixture(t);
  assert.equal((await adapter.preflight()).schemaMaxReferences, 16);
  assert.equal(sdk.options.mode, "empty");
  assert.equal(sdk.options.runtime.kind, "spawned-stdio");
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GOOGLE_API_KEY", "COPILOT_GITHUB_TOKEN", "NODE_OPTIONS"]) {
    assert.equal(Object.hasOwn(sdk.options.runtime.env, k), false);
  }
  assert.equal(sdk.calls.length, 0);
  assert.deepEqual(await readdir(workRoot), []);
});

test("a trusted host identity is used at client and session scope without ambient login fallback", async t => {
  let resolutions = 0;
  const { adapter, sdk } = await fixture(t, { profileAuth: async signal => {
    signal.throwIfAborted();
    resolutions++;
    return { token: "synthetic-credential-for-fixture-only", cacheDirectory: "/fixture/cache", distribution: "/fixture/dist" };
  } });
  await adapter.preflight();
  assert.equal(resolutions, 1);
  assert.equal(sdk.options.github.useLoggedInUser, false);
  assert.equal(sdk.options.github.token, "synthetic-credential-for-fixture-only");
  assert.equal(sdk.sessions[0].github.token, sdk.options.github.token);
  assert.equal(sdk.options.runtime.env.COPILOT_CLI_DIST_DIR, "/fixture/dist");
  assert.ok(!Object.values(sdk.options.runtime.env).includes(sdk.options.github.token));
  assert.equal(sdk.calls.length, 0);
});

test("host profile selection refuses a simulator before it can resolve credentials", () => {
  assert.throws(() => hostProfileAuth({}, { authProfileId: "github-copilot:github",
    cliPath: process.execPath, workRoot: "/dev/shm/fixture" }), /pinned official Linux runtime/);
});

test("identity or capability failures never execute an image request", async t => {
  const { sdk, adapter } = await fixture(t);
  const job = { prompt: "A circle", references: [] };
  sdk.login = "not-the-configured-account";
  await assert.rejects(adapter.submitImage(job), /account.*nothing submitted/i);
  sdk.login = "image-user";
  sdk.tools = [descriptor, { name: "shell" }];
  await assert.rejects(adapter.submitImage(job), /tool.*nothing submitted/i);
  assert.equal(sdk.calls.length, 0);
  sdk.tools = [descriptor];
  assert.deepEqual(await adapter.submitImage(job), image);
  assert.deepEqual(sdk.calls.map(r => r.arguments), [{ prompt: "A circle" }]);
});

test("cancellation during SDK startup cannot lead to a later paid execution", async t => {
  const { sdk, adapter } = await fixture(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const job = { prompt: "One circle", references: [] };
  sdk.onStart = () => { started.resolve(); return release.promise; };
  const controller = new AbortController();
  const expired = assert.rejects(adapter.submitImage(job, controller.signal), /nothing submitted/);
  await started.promise;
  controller.abort();
  release.resolve();
  await expired;
  assert.equal(sdk.calls.length, 0);
  assert.deepEqual(await adapter.submitImage(job), image);
});

test("after execute, a damaged or multiple PNG result never causes an automatic second attempt", async t => {
  for (const kind of ["truncated", "multiple", "execution-error"]) {
    const { sdk, adapter } = await fixture(t);
    const part = sdk.result.binaryResultsForLlm[0];
    if (kind === "multiple") sdk.result.binaryResultsForLlm.push(part);
    else if (kind === "truncated") part.data = png.subarray(0, -12).toString("base64");
    else sdk.onExecute = () => { throw new Error("sensitive remote response text"); };
    const job = { prompt: "One circle", references: [] };
    await assert.rejects(adapter.submitImage(job), /do not retry/);
    assert.equal(sdk.calls.length, 1);
  }
});

test("a confirmed result followed by shutdown failure is reported without resubmitting", async t => {
  const { sdk, adapter, workRoot } = await fixture(t);
  const job = { prompt: "A circle", references: [] };
  sdk.stopErrors = [new Error("private shutdown details")];
  await assert.rejects(adapter.submitImage(job), /Image completed but failed while stopping/);
  assert.equal(sdk.calls.length, 1);
  assert.deepEqual(await readdir(workRoot), []);
});
