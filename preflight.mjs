import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopilotImageAdapter } from "./copilot-adapter.mjs";

const [cliPath, expectedLogin, ...extra] = process.argv.slice(2);
if (!cliPath || !expectedLogin || extra.length) throw new Error("Usage: node preflight.mjs ABSOLUTE_NATIVE_CLI_PATH EXPECTED_GITHUB_LOGIN");
const workRoot = await mkdtemp(join(tmpdir(), "copilot-image-preflight-"));
try {
  const adapter = createCopilotImageAdapter({ cliPath, expectedLogin, workRoot });
  console.log(JSON.stringify(await adapter.preflight(), null, 2));
} finally {
  await rmdir(workRoot);
}
