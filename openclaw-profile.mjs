import { trustedRuntime } from "./trusted-runtime.mjs";

export function hostProfileAuth({ cfg, agentDir, workspaceDir, authStore }, { authProfileId, cliPath, workRoot }) {
  if (typeof authProfileId !== "string" || !/^github-copilot:[^\s\x00-\x1f\x7f]+(?![\s\S])/u.test(authProfileId)) {
    throw new Error("Existing profile auth requires an explicit GitHub Copilot profile");
  }
  const verifyRuntime = trustedRuntime(cliPath, workRoot);
  return async signal => {
    const runtime = await verifyRuntime(signal);
    const { resolveApiKeyForProvider } = await import("openclaw/plugin-sdk/provider-auth-runtime");
    const auth = await resolveApiKeyForProvider({ provider: "github-copilot", cfg, profileId: authProfileId, lockedProfile: true,
      workspaceDir, agentDir, store: authStore, signal });
    if (auth.profileId !== authProfileId || auth.mode !== "token" || typeof auth.apiKey !== "string" || !auth.apiKey.trim()) {
      throw new Error("Expected profile was not resolved; no alternate identity is permitted");
    }
    return { token: auth.apiKey, ...runtime };
  };
}
