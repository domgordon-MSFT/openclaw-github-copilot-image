# GitHub Copilot image generation for OpenClaw

This unofficial preview adds `github-copilot/image-generation` to OpenClaw's built-in `image_generate` tool. Ask your agent to make an image or edit an attachment as usual. The host still controls tool access, input loading, task scheduling, and delivery. The plugin does not intercept chat or add a Discord allowlist.

`image-generation` is this plugin's name for Copilot's image tool, not a selectable server-side model ID. The Copilot backend returns one PNG per call and advertises up to 16 ordered reference images. OpenClaw handles unsupported options according to the provider's advertised capabilities.

## Installation

Compatibility is determined by where the OpenClaw gateway runs, not by the device you use to talk to it. This preview targets stock Node-based OpenClaw `2026.11.7` through `2026.11.10`, with Node `24.22.1` in CI and Copilot CLI `1.0.114`.

| Gateway | Architecture | Job storage |
| --- | --- | --- |
| glibc Linux, bare host or Docker | x64, ARM64 | Private directory directly under `/dev/shm` |
| Native macOS | x64, ARM64 | Private directory directly under `/private/tmp` |
| Native Windows | x64 | Private directory directly under the gateway user's `%LOCALAPPDATA%` |
| Windows ARM64, musl Linux, Bun and compiled OpenClaw builds | Not supported | |

A Windows host can use a supported Linux gateway in Docker or WSL2. You need an existing OpenClaw GitHub Copilot token profile and a Copilot account whose plan and policy enable image generation. The plugin cannot turn on entitlement or tell you the price of a request.

1. Provision the pinned CLI once. Run `sudo node scripts/prepare-runtime.mjs` from a reviewed checkout on a target with Node, npm and system tar. On Windows x64 use the official Node distribution and run `node .\scripts\prepare-runtime.mjs` in an elevated terminal, then run the gateway without elevation. The default install is `OpenClaw Copilot Image CLI 1.0.114` under Program Files. For Docker, run the script as root in a build based on your pinned OpenClaw image, then switch back to the normal non-root gateway user. Alternatively mount the provisioned directory read-only at `/opt/agency-copilot-image-cli-1.0.114`; it must appear root-owned inside the gateway. A different protected, canonical CLI path is allowed if it preserves the adjacent provisioned cache. The script verifies both the official npm archive and the executable against `runtime-pins.json` before installing them.
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

3. On macOS replace `workRoot` with `/private/tmp/copilot-image-jobs-UID` (replace `UID` with the non-root gateway user's numeric ID). On Windows, set `cliPath` to the full installed `copilot.exe` path and `workRoot` to a full path such as `C:\Users\your-user\AppData\Local\copilot-image-jobs`. Windows and macOS job storage is private and temporary but is not guaranteed to be RAM-backed. As the gateway OS user, run `node profile-preflight.mjs EXPECTED_LOGIN PROFILE_ID AGENT_ID [CLI_PATH]` from the installed plugin directory to check identity and confirm the runtime supports the advertised reference limit without generating an image. Preflight uses a separate private temporary directory. The plugin resolves only the named OpenClaw Copilot profile. No extra PAT or login is needed. A saved standalone Copilot CLI login is not supported.

Requests from everyone allowed to use the stock tool draw on the configured Copilot account. There is no plugin-specific quota or sender allowlist. The example sets no fallback, so a Copilot failure won't launch a Google image request. Do not assume a failed or timed-out request was free. To roll back, restore your previous `agents.defaults.mediaModels.image` configuration and disable this plugin.

## Verification

Run `docker build --file test/Dockerfile .` for the clean Linux setup and integration checks. Set build argument `OPENCLAW_VERSION` to test another listed release. For a local run, use `npm ci --ignore-scripts` and `npm test`, then set `OPENCLAW_TEST_ROOT` to a supported stock OpenClaw npm install and run `npm run test:package`. CI separately verifies and starts the official platform runtime without credentials, then exercises the native tool with the real SDK and a simulated Copilot peer. These checks do not consume credits. Live authenticated Discord create and edit were verified on Linux x64; CI on the other targets does not prove live entitlement or delivery there.
