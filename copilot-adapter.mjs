import { CopilotClient, RuntimeConnection } from "@microsoft/copilot-sdk";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { crc32 } from "node:zlib";
import { ImageCompletedError, ImageNotSubmittedError } from "./image-errors.mjs";
import { isolatedRuntimeEnv, protocol, version } from "./trusted-runtime.mjs";

const imageTool = "image_generation";
export const maxInputImages = 16;
const maxPngBytes = 64 * 1024 * 1024;
const extensions = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"]]);

export class CopilotExecutionError extends Error {
  constructor(result, permissions) {
    super("Copilot image execution did not return a confirmed PNG; do not retry");
    this.diagnostic = [result, ...permissions].join(",");
  }
}

function decodePng(result) {
  const parts = result?.binaryResultsForLlm;
  if (result?.resultType !== "success" || parts?.length !== 1 || parts[0]?.type !== "image" ||
    parts[0].mimeType !== "image/png") throw new Error("Copilot did not return exactly one PNG");
  const { data } = parts[0];
  if (typeof data !== "string" || data.length > 4 * Math.ceil(maxPngBytes / 3)) throw new Error("Invalid Copilot image size");
  const buffer = Buffer.from(data, "base64");
  if (buffer.length > maxPngBytes || buffer.toString("base64") !== data ||
    !buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Invalid PNG encoding");
  let hasData = false;
  for (let i = 8; i + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(i);
    const end = i + 8 + length;
    if (end + 4 > buffer.length || crc32(buffer.subarray(i + 4, end)) !== buffer.readUInt32BE(end)) break;
    const type = buffer.toString("latin1", i + 4, i + 8);
    if (type === "IHDR") {
      if (i !== 8 || length !== 13 || !buffer.readUInt32BE(i + 8) || !buffer.readUInt32BE(i + 12)) break;
    } else if (i === 8) break;
    if (type === "IDAT" && length) hasData = true;
    if (type === "IEND") {
      if (hasData && length === 0 && end + 4 === buffer.length) return { buffer, mimeType: "image/png" };
      break;
    }
    i = end + 4;
  }
  throw new Error("Incomplete or corrupt Copilot PNG");
}

function childEnvironment() {
  const keys = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "COMSPEC",
    "PATHEXT", "TEMP", "TMP", "TMPDIR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
  return Object.fromEntries(keys.filter(k => process.env[k]).map(k => [k, process.env[k]]));
}

function failureCategory(details) {
  if (typeof details !== "string") return "unclassified";
  if (/permission|denied|not allowed/i.test(details)) return "permission";
  if (/file|path|reference|input.image/i.test(details)) return "input";
  if (/rate.limit|quota|429/i.test(details)) return "quota";
  if (/timeout|timed out|deadline/i.test(details)) return "timeout";
  return "unclassified";
}

function imageSchema(metadata) {
  const tools = metadata?.tools;
  if (tools?.length !== 1 || tools[0].name !== imageTool) throw new Error("Expected an image-only Copilot session");
  const props = tools[0].input_schema?.properties;
  const refs = props?.input_images;
  if (props?.prompt?.type !== "string" || !Number.isSafeInteger(props.prompt.maxLength) ||
    refs?.type !== "array" || !Number.isSafeInteger(refs.maxItems) || refs.maxItems < maxInputImages ||
    !refs.items?.oneOf?.some(v => v.properties?.path?.type === "string" && v.required?.includes("path")) ||
    !Array.isArray(props.size?.enum) || !Array.isArray(props.quality?.enum)) {
    throw new Error("Unsupported Copilot image tool schema");
  }
  return props;
}

async function stageArguments(job, props, workingDirectory) {
  if (typeof job.prompt !== "string" || !job.prompt.trim() || job.prompt.length > props.prompt.maxLength ||
    !Array.isArray(job.references) || job.references.length > maxInputImages ||
    (job.size !== undefined && !props.size.enum.includes(job.size)) ||
    (job.quality !== undefined && !props.quality.enum.includes(job.quality))) {
    throw new Error("Approved image operation exceeds the Copilot tool schema");
  }
  const args = { prompt: job.prompt };
  if (job.size !== undefined) args.size = job.size;
  if (job.quality !== undefined) args.quality = job.quality;
  const inputs = [];
  for (const [index, ref] of job.references.entries()) {
    const ext = extensions.get(ref?.mimeType);
    if (!ext || !Buffer.isBuffer(ref.buffer) || !ref.buffer.length) throw new Error("Invalid approved image reference");
    const path = join(workingDirectory, `reference-${index + 1}.${ext}`);
    await writeFile(path, ref.buffer, { mode: 0o600, flag: "wx" });
    inputs.push({ path });
  }
  if (inputs.length) args.input_images = inputs;
  return args;
}

/** Construct locally; the SDK starts only for an explicit preflight or guarded submission. */
export function createCopilotImageAdapter({ cliPath, expectedLogin, workRoot, profileAuth }, makeClient = opts => new CopilotClient(opts)) {
  if (!isAbsolute(cliPath) || !isAbsolute(workRoot) || typeof expectedLogin !== "string" || !expectedLogin.trim()) {
    throw new Error("Absolute native CLI and private work root paths and an expected GitHub login are required");
  }

  async function withSession(job, signal, attempt) {
    signal.throwIfAborted();
    attempt.phase = "resolving the configured OpenClaw Copilot profile";
    const identity = profileAuth ? await profileAuth(signal) : undefined;
    if (profileAuth && !identity?.token) throw new Error("Missing explicit Copilot identity");
    signal.throwIfAborted();
    attempt.phase = "creating the private Copilot work directory";
    const root = await lstat(workRoot);
    if (!root.isDirectory() || (process.platform !== "win32" && (root.uid !== process.getuid() || (root.mode & 0o077)))) {
      throw new Error("Expected a private work directory owned by the runtime user");
    }
    const directory = await mkdtemp(join(workRoot, "copilot-image-"));
    const workingDirectory = join(directory, "work");
    let client;
    let forcedStop;
    const interrupt = () => {
      // Convert failure to a value so shutdown cannot produce an unhandled rejection.
      forcedStop ??= client.forceStop().then(() => true, () => false);
    };
    let permittedId;
    let permittedArgs;
    let imageApproved = false;
    const unreadReferences = new Set();
    const permissions = attempt.permissions;
    try {
      await mkdir(workingDirectory, { mode: 0o700 });
      client = makeClient({
        mode: "empty", github: identity ? { token: identity.token, useLoggedInUser: false } : { useLoggedInUser: true },
        observability: { logLevel: "none" },
        runtime: RuntimeConnection.forSpawnedStdio({
          path: cliPath, workingDirectory, baseDirectory: join(directory, "state"),
          env: identity ? isolatedRuntimeEnv(directory, identity) : childEnvironment(),
        }),
      });
      attempt.phase = "starting the Copilot runtime";
      signal.addEventListener("abort", interrupt, { once: true });
      signal.throwIfAborted();
      await client.start();
      signal.throwIfAborted();
      attempt.phase = "verifying runtime compatibility";
      const status = await client.getStatus();
      if (status.version !== version || status.protocolVersion !== protocol) throw new Error("Incompatible Copilot runtime");
      signal.throwIfAborted();
      attempt.phase = "verifying the expected Copilot account";
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated || auth.login?.toLowerCase() !== expectedLogin.toLowerCase()) {
        throw new Error("Expected Copilot account is not authenticated");
      }
      signal.throwIfAborted();
      attempt.phase = "verifying the image-only tool session";
      const session = await client.createSession({
        workingDirectory, enableConfigDiscovery: false, github: { telemetryEnabled: false, ...(identity && { token: identity.token }) },
        tools: { availableTools: [imageTool], imageGeneration: { enabled: true, saveToDisk: false } },
        permissions: { onRequest: request => {
          if (request.kind === "read") {
            // This private empty-mode session has only one active invocation and no other tools.
            if (permittedId && imageApproved && !signal.aborted && !request.managedApprovalRequired &&
              !request.requestSandboxBypass && !request.sandboxPathGrant &&
              (request.toolCallId === undefined || request.toolCallId === permittedId) &&
              (request.resolvedPath === undefined || request.resolvedPath === request.path) &&
              unreadReferences.delete(request.path)) {
              permissions.add("reference-read-approved");
              return { kind: "approve-once" };
            }
            permissions.add(permittedArgs?.input_images?.some(input => input.path === request.path) ? "reference-read-denied" : "other-read-denied");
          }
          if (permittedId && !imageApproved && !signal.aborted && request.kind === "custom-tool" && request.toolName === imageTool &&
            request.toolCallId === permittedId && !request.managedApprovalRequired &&
            (request.args === undefined || isDeepStrictEqual(request.args, permittedArgs))) {
            imageApproved = true;
            permissions.add("image-approved");
            return { kind: "approve-once" };
          }
          if (request.kind === "custom-tool") permissions.add("custom-tool-denied");
          return { kind: "reject", feedback: "Not the authorized image invocation" };
        } },
      });
      signal.throwIfAborted();
      await session.rpc.tools.initializeAndValidate();
      const props = imageSchema(await session.rpc.tools.getCurrentMetadata());
      signal.throwIfAborted();
      if (job === preflightOnly) return { version, protocol, tool: imageTool, schemaMaxReferences: props.input_images.maxItems,
        sizes: props.size.enum, qualities: props.quality.enum };
      attempt.phase = "validating and staging approved image inputs";
      permittedArgs = await stageArguments(job, props, workingDirectory);
      for (const { path } of permittedArgs.input_images ?? []) unreadReferences.add(path);
      signal.throwIfAborted();
      permittedId = randomUUID();
      attempt.sent = true;
      attempt.result = "rpc-rejected";
      let result;
      try {
        result = await session.rpc.tools.execute({ name: imageTool, toolCallId: permittedId, arguments: permittedArgs });
      } catch (error) {
        attempt.result = `rpc-rejected:${failureCategory(error?.message)}`;
        throw error;
      } finally {
        permittedId = undefined;
        unreadReferences.clear();
      }
      attempt.result = result?.resultType === "success" ? "unusable-image" :
        `tool-failed:${failureCategory(result?.error ?? result?.textResultForLlm)}`;
      const image = decodePng(result);
      attempt.completed = true;
      return image;
    } finally {
      permittedId = undefined;
      try {
        if (client && !forcedStop && (await client.stop()).length) {
          throw new Error("Copilot runtime shutdown reported errors");
        }
        if (forcedStop && !await forcedStop) throw new Error("Copilot runtime could not be stopped");
      } catch {
        attempt.phase = "stopping the Copilot runtime";
        if (client && !forcedStop) await client.forceStop();
        throw new Error("Copilot shutdown failed");
      } finally {
        signal.removeEventListener("abort", interrupt);
        try { await rm(directory, { recursive: true, force: true }); } catch {
          attempt.phase = "cleaning the private Copilot work directory";
          throw new Error("Copilot file cleanup failed");
        }
      }
    }
  }
  async function run(job, signal) {
    const attempt = { sent: false, completed: false, phase: "creating the private Copilot work directory", permissions: new Set() };
    try {
      return await withSession(job, signal, attempt);
    } catch {
      // SDK errors can contain request content, references or server response bodies.
      if (!attempt.sent) throw new ImageNotSubmittedError(`Failed while ${attempt.phase}; nothing submitted`);
      if (attempt.completed) throw new ImageCompletedError(`Image completed but failed while ${attempt.phase}; do not retry`);
      throw new CopilotExecutionError(attempt.result, attempt.permissions);
    }
  }
  const preflightOnly = Symbol("metadata only");
  return {
    preflight: () => run(preflightOnly, AbortSignal.timeout(30_000)),
    submitImage: (job, signal = AbortSignal.timeout(180_000)) => run(job, signal),
  };
}
