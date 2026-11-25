import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";

export const officialCli = "/opt/agency-copilot-image-cli-1.0.114/copilot";
const cliHash = "990cc6cf4e171ef88b6e3c873f7b62c0dc044b223a7ace518ac284baf2578fc6";

async function requireOperatorOwned(path) {
  if (await realpath(path) !== path) throw new Error("Image runtime must not be redirected");
  for (let current = path;; current = dirname(current)) {
    const st = await lstat(current);
    if (st.uid !== 0 || (st.mode & 0o022)) throw new Error("Image runtime must be operator-owned and immutable to the gateway user");
    if (current === "/") break;
  }
}

export function hostProfileAuth({ cfg, agentDir, workspaceDir, authStore }, { authProfileId, cliPath, workRoot }) {
  if (process.platform !== "linux" || process.arch !== "x64" || cliPath !== officialCli || dirname(workRoot) !== "/dev/shm" ||
    !/^github-copilot:[\w.-]+$/.test(authProfileId)) {
    throw new Error("Existing profile auth requires an explicit GitHub Copilot profile and the pinned official Linux runtime");
  }
  return async signal => {
    const cacheDirectory = join(dirname(officialCli), "cache");
    const distribution = join(cacheDirectory, "pkg/linux-x64/1.0.114");
    await requireOperatorOwned(officialCli);
    await requireOperatorOwned(distribution);
    if ((await statfs(workRoot)).type !== 0x01021994) throw new Error("Profile-backed image jobs require private tmpfs storage");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(officialCli, { signal })) hash.update(chunk);
    if (hash.digest("hex") !== cliHash) throw new Error("Unexpected Copilot executable");
    const { resolveApiKeyForProvider } = await import("openclaw/plugin-sdk/provider-auth-runtime");
    const auth = await resolveApiKeyForProvider({ provider: "github-copilot", cfg, profileId: authProfileId, lockedProfile: true,
      workspaceDir, agentDir, store: authStore, signal });
    if (auth.profileId !== authProfileId || auth.mode !== "token" || typeof auth.apiKey !== "string" || !auth.apiKey.trim()) {
      throw new Error("Expected profile was not resolved; no alternate identity is permitted");
    }
    return { token: auth.apiKey, cacheDirectory, distribution };
  };
}
