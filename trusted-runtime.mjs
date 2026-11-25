import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pins from "./runtime-pins.json" with { type: "json" };

export const { version, protocol } = pins;
const windows = process.platform === "win32";
export const executable = windows ? "copilot.exe" : "copilot";
export const defaultCli = windows ? join(process.env.ProgramFiles ?? "", `OpenClaw Copilot Image CLI ${version}`, executable) :
  `/opt/agency-copilot-image-cli-${version}/copilot`;
export const jobParent = windows ? process.env.LOCALAPPDATA :
  process.platform === "darwin" ? "/private/tmp" : "/dev/shm";
const windowsSystem = () => join(process.env.SystemRoot ?? "", "System32");
const powershell = () => join(windowsSystem(), "WindowsPowerShell", "v1.0", "powershell.exe");
const aclScript = fileURLToPath(new URL("./scripts/windows-acl.ps1", import.meta.url));

export function windowsSystemEnv() {
  if (!windows) return {};
  const root = process.env.SystemRoot;
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("Missing Windows SystemRoot");
  return { SystemRoot: root, WINDIR: root, PATH: windowsSystem(), PATHEXT: ".COM;.EXE" };
}

export function windowsAclSync(mode, path) {
  execFileSync(powershell(), ["-NoProfile", "-NonInteractive", "-File", aclScript, mode, path], {
    env: windowsSystemEnv(), windowsHide: true,
  });
}

async function windowsAcl(mode, path, signal) {
  try {
    await promisify(execFile)(powershell(), ["-NoProfile", "-NonInteractive", "-File", aclScript, mode, path],
      { env: windowsSystemEnv(), windowsHide: true, signal });
  } catch {
    throw new Error("Windows rejected the Copilot runtime or job directory permissions");
  }
}

export function isolatedRuntimeEnv(directory, { cacheDirectory, distribution }) {
  return { ...windowsSystemEnv(), ...(!windows && { PATH: "/usr/bin:/bin" }), HOME: directory, TMPDIR: directory,
    ...(windows && { USERPROFILE: directory, LOCALAPPDATA: directory, APPDATA: directory, TEMP: directory, TMP: directory }),
    COPILOT_AUTO_UPDATE: "false", COPILOT_CACHE_HOME: cacheDirectory,
    ...(distribution && { COPILOT_CLI_DIST_DIR: distribution }) };
}

export function runtimeTarget() {
  const key = `${process.platform}-${process.arch}`;
  const pin = pins.targets[key];
  if (!pin || (process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime)) {
    throw new Error("Profile authentication requires a supported Windows, macOS or glibc Linux gateway");
  }
  return { key, ...pin };
}

export async function hashFile(file, algorithm, encoding, signal) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest(encoding);
}

async function requireOperatorOwned(path) {
  if (await realpath(path) !== path) throw new Error("Image runtime must not be redirected");
  const parents = [];
  for (let current = path;; current = dirname(current)) {
    await requireImmutable(current);
    parents.push(current);
    if (dirname(current) === current) break;
  }
  if (process.platform === "darwin") requireNoMacAclGrant(["-lde", ...parents]);
}

async function requireImmutable(path) {
  const st = await lstat(path);
  if (st.uid !== 0 || (st.mode & 0o022) || (!st.isDirectory() && !st.isFile())) {
    throw new Error("Image runtime must be root-owned and immutable to the gateway user");
  }
  try {
    await access(path, constants.W_OK);
  } catch (error) {
    if (error.code === "EACCES" || error.code === "EROFS") return st;
    throw error;
  }
  throw new Error("Gateway user can modify Copilot runtime");
}

async function verifyDistribution(directory) {
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    if ((await requireImmutable(path)).isDirectory()) await verifyDistribution(path);
  }

  function requireNoMacAclGrant(args) {
    const acl = execFileSync("/bin/ls", args, { encoding: "utf8", env: { LC_ALL: "C" } });
    if (/^\s+\d+:.*\ballow\b/m.test(acl)) throw new Error("Unexpected ACL grant on Copilot runtime or job storage");
  }
}

export function trustedRuntime(cliPath, workRoot) {
  const target = runtimeTarget();
  if ((!windows && process.getuid() === 0) || !isAbsolute(cliPath) || basename(cliPath) !== executable ||
    !jobParent || !isAbsolute(jobParent) || typeof workRoot !== "string" || dirname(workRoot) !== jobParent ||
    join(jobParent, basename(workRoot)) !== workRoot) {
    throw new Error(`Use a non-root gateway, an absolute Copilot path, and a private directory directly under ${jobParent}`);
  }
  return async signal => {
    const cacheDirectory = join(dirname(cliPath), "cache");
    const distribution = join(cacheDirectory, "pkg", target.key, version);
    if (windows) {
      await windowsAcl("runtime", dirname(cliPath), signal);
    } else {
      await requireOperatorOwned(cliPath);
      await requireOperatorOwned(distribution);
      await verifyDistribution(distribution);
      if (process.platform === "darwin") requireNoMacAclGrant(["-lRe", distribution]);
    }
    if ((await lstat(cliPath)).isFile() !== true || (await lstat(distribution)).isDirectory() !== true ||
      await hashFile(cliPath, "sha256", "hex", signal) !== target.executableSha256) {
      throw new Error("Unexpected Copilot executable or distribution");
    }
    await requirePrivateWorkRoot(workRoot, signal);
    return { cacheDirectory, distribution };
  };
}

async function requirePrivateWorkRoot(workRoot, signal) {
  const parent = dirname(workRoot);
  if (windows) {
    await windowsAcl("private", parent, signal);
    await mkdir(workRoot, { mode: 0o700, recursive: true });
    await windowsAcl("private", workRoot, signal);
    return;
  }
  const st = await lstat(parent);
  if (!st.isDirectory() || st.uid !== 0 || !(st.mode & 0o1000) || await realpath(parent) !== parent ||
    (process.platform === "linux" && (await statfs(parent)).type !== 0x01021994)) {
    throw new Error("Expected a trusted temporary parent for Copilot image jobs");
  }
  await mkdir(workRoot, { mode: 0o700, recursive: true });
  const root = await lstat(workRoot);
  if (!root.isDirectory() || root.uid !== process.getuid() || (root.mode & 0o077)) {
    throw new Error("Expected a private work directory owned by the gateway user");
  }
  if (process.platform === "darwin") requireNoMacAclGrant(["-lde", parent, workRoot]);
}
