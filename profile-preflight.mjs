import { mkdtemp, rmdir } from "node:fs/promises";
import { captureRuntimeConfigAsyncReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { createCopilotImageAdapter } from "./copilot-adapter.mjs";
import { hostProfileAuth, officialCli } from "./openclaw-profile.mjs";

const [expectedLogin, authProfileId, agentId, ...extra] = process.argv.slice(2);
if (!expectedLogin || !authProfileId || !/^[a-z0-9][a-z0-9_-]*$/i.test(agentId ?? "") || extra.length) {
  throw new Error("Usage: node profile-preflight.mjs EXPECTED_LOGIN PROFILE_ID AGENT_ID");
}
const config = await captureRuntimeConfigAsyncReader()();
const context = { cfg: config, agentDir: resolveAgentDir(config, agentId), workspaceDir: resolveAgentWorkspaceDir(config, agentId) };
const workRoot = await mkdtemp("/dev/shm/copilot-image-preflight-");
try {
  const options = { expectedLogin, authProfileId, cliPath: officialCli, workRoot };
  const adapter = createCopilotImageAdapter({ ...options, profileAuth: hostProfileAuth(context, options) });
  console.log(JSON.stringify({ agentId, ...(await adapter.preflight()), imageExecutionRPCs: 0 }));
} finally {
  await rmdir(workRoot);
}
