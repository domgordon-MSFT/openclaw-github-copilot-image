# GitHub Copilot image generation for OpenClaw

This unofficial preview adds `github-copilot/image-generation` to OpenClaw's built-in `image_generate` tool. Ask your agent to make an image or edit an attachment as usual. The host still controls tool access, input loading, task scheduling, and delivery. The plugin does not intercept chat or add a Discord allowlist.

`image-generation` is this plugin's name for Copilot's image tool, not a selectable server-side model ID. The Copilot backend returns one PNG per call and advertises up to 16 ordered reference images. OpenClaw handles unsupported options according to the provider's advertised capabilities.

## Installation

The supported preview target is **Linux x64**, stock OpenClaw `2026.11.7`, Node `24.22.1`, and Copilot CLI `1.0.114`. You need an existing OpenClaw GitHub Copilot token profile and a Copilot account whose plan and policy enable image generation. The plugin cannot turn on entitlement or tell you the price of a request.

1. Provision the pinned CLI once. On a Linux x64 host with Node, npm, OpenSSL and GNU coreutils, run `sudo sh scripts/prepare-linux-runtime.sh` from a reviewed checkout. For Docker, run this same script as root in a build based on your pinned OpenClaw image, then switch back to the image's normal non-root user. Alternatively mount the provisioned directory read-only at `/opt/agency-copilot-image-cli-1.0.114`; it must appear root-owned inside the gateway. Keep `/dev/shm` writable for private job files. The script verifies the npm archive and executable before publishing the root-owned runtime directory.
2. From a reviewed checkout run `npm pack --ignore-scripts`. Install the resulting archive from inside the OpenClaw environment with `openclaw plugins install --force --no-enable 'npm-pack:<absolute-archive-path>'`. Review and accept the declared image-provider capability when prompted, or pass `--accept-capabilities` after that review. Then merge this configuration, replacing the example login and profile ID as needed:

```json
{
  "plugins": {
    "entries": {
      "github-copilot-image": {
        "enabled": true,
        "config": {
          "cliPath": "/opt/agency-copilot-image-cli-1.0.114/copilot",
          "workRoot": "/dev/shm/copilot-image-jobs",
          "authProfileId": "github-copilot:github",
          "expectedLogin": "YOUR_GITHUB_LOGIN"
        }
      }
    }
  },
  "agents": {
    "defaults": {
      "mediaModels": {
        "image": { "primary": "github-copilot/image-generation", "fallbacks": [] }
      }
    }
  }
}
```

Add `github-copilot-image` to `plugins.allow` if using an allowlist. Preserve other plugin and model settings. If migrating from the experimental ingress plugin, disable `agency-copilot-images` and remove only the `image_generate` denies previously added by that deployment. The native tool handles normal OpenClaw permissions for all callers. Chat model configuration is independent.

3. Run `node profile-preflight.mjs EXPECTED_LOGIN PROFILE_ID AGENT_ID` from the installed plugin directory to check identity and the image tool schema without generating an image. Profile-backed mode uses the native tool's agent context to resolve only the named Copilot profile. No extra PAT or login is needed. For a standalone CLI login, omit `authProfileId` and supply a private, existing `workRoot`; use `node preflight.mjs ABSOLUTE_CLI_PATH EXPECTED_LOGIN` for the metadata check.

Requests from everyone allowed to use the stock tool draw on the configured Copilot account. There is no plugin-specific quota or sender allowlist. The example sets no fallback, so a Copilot failure won't launch a Google image request. Do not assume a failed or timed-out request was free. To roll back, restore your previous `agents.defaults.mediaModels.image` configuration and disable this plugin.

## Verification

Run `docker build --platform linux/amd64 --file test/Dockerfile .` for the same clean Linux setup and integration checks as CI. For a local run, use `npm ci --ignore-scripts` and `npm test`, then set `OPENCLAW_TEST_ROOT` to an installed stock `openclaw@2026.11.7` package and run `npm run test:package`. These checks exercise provider discovery, the built-in tool, and the real SDK with a simulated Copilot peer. They do not consume Copilot credits.
