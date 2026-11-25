import { mkdtemp, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { captureRuntimeConfigAsyncReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { createCopilotImageAdapter } from "./copilot-adapter.mjs";
import { hostProfileAuth } from "./openclaw-profile.mjs";
import { defaultCli, jobParent } from "./trusted-runtime.mjs";

const [expectedLogin, authProfileId, agentId, cliPath = defaultCli, ...extra] = process.argv.slice(2);
if (!expectedLogin || !authProfileId || !/^[a-z0-9][a-z0-9_-]*$/i.test(agentId ?? "") || extra.length) {
  throw new Error("Usage: node profile-preflight.mjs EXPECTED_LOGIN PROFILE_ID AGENT_ID [CLI_PATH]");
}
const config = await captureRuntimeConfigAsyncReader()();
const context = { cfg: config, agentDir: resolveAgentDir(config, agentId), workspaceDir: resolveAgentWorkspaceDir(config, agentId) };
const workRoot = await mkdtemp(join(jobParent, "copilot-image-preflight-"));
try {
  const options = { expectedLogin, authProfileId, cliPath, workRoot };
  const adapter = createCopilotImageAdapter({ ...options, profileAuth: hostProfileAuth(context, options) });
  console.log(JSON.stringify({ agentId, ...(await adapter.preflight()), imageExecutionRPCs: 0 }));
} finally {
  await rmdir(workRoot);
}
