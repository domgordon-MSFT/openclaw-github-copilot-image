import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection } from "@microsoft/copilot-sdk";
import { defaultCli, jobParent, protocol, trustedRuntime, version } from "../trusted-runtime.mjs";

const workRoot = await mkdtemp(join(jobParent, "copilot-image-smoke-"));
try {
  const { cacheDirectory, distribution } = await trustedRuntime(defaultCli, workRoot)(AbortSignal.timeout(30_000));
  const work = join(workRoot, "work");
  await mkdir(work, { mode: 0o700 });
  const client = new CopilotClient({
    mode: "empty", github: { useLoggedInUser: false }, observability: { logLevel: "none" },
    runtime: RuntimeConnection.forSpawnedStdio({
      path: defaultCli, workingDirectory: work, baseDirectory: join(workRoot, "state"),
      env: { HOME: workRoot, TMPDIR: workRoot, PATH: "/usr/bin:/bin", COPILOT_AUTO_UPDATE: "false",
        COPILOT_CACHE_HOME: cacheDirectory, COPILOT_CLI_DIST_DIR: distribution },
    }),
  });
  try {
    await client.start();
    const status = await client.getStatus();
    assert.equal(status.version, version);
    assert.equal(status.protocolVersion, protocol);
  } finally {
    assert.deepEqual(await client.stop(), []);
  }
} finally {
  await rm(workRoot, { recursive: true, force: true });
}
