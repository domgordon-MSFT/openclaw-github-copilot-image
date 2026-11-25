import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import pins from "./runtime-pins.json" with { type: "json" };

export const { version, protocol } = pins;
export const defaultCli = `/opt/agency-copilot-image-cli-${version}/copilot`;
export const jobParent = process.platform === "darwin" ? "/private/tmp" : "/dev/shm";

export function runtimeTarget() {
  const key = `${process.platform}-${process.arch}`;
  const pin = pins.targets[key];
  if (!pin || (process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime)) {
    throw new Error("Profile authentication requires a supported macOS or glibc Linux gateway");
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
  for (let current = path;; current = dirname(current)) {
    await requireImmutable(current);
    if (dirname(current) === current) break;
  }
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
}

export function trustedRuntime(cliPath, workRoot) {
  const target = runtimeTarget();
  if (process.getuid() === 0 || !isAbsolute(cliPath) || basename(cliPath) !== "copilot" ||
    typeof workRoot !== "string" || dirname(workRoot) !== jobParent || join(jobParent, basename(workRoot)) !== workRoot) {
    throw new Error(`Use a non-root gateway, an absolute Copilot path, and a private directory directly under ${jobParent}`);
  }
  return async signal => {
    const cacheDirectory = join(dirname(cliPath), "cache");
    const distribution = join(cacheDirectory, "pkg", target.key, version);
    await requireOperatorOwned(cliPath);
    await requireOperatorOwned(distribution);
    if ((await lstat(cliPath)).isFile() !== true || (await lstat(distribution)).isDirectory() !== true ||
      await hashFile(cliPath, "sha256", "hex", signal) !== target.executableSha256) {
      throw new Error("Unexpected Copilot executable or distribution");
    }
    await verifyDistribution(distribution);
    await requirePrivateWorkRoot(workRoot);
    return { cacheDirectory, distribution };
  };
}

async function requirePrivateWorkRoot(workRoot) {
  const parent = dirname(workRoot);
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
  if (process.platform === "darwin") {
    const acl = execFileSync("/bin/ls", ["-lde", parent, workRoot], { encoding: "utf8", env: { LC_ALL: "C" } });
    if (/^\s+\d+:/m.test(acl)) throw new Error("Unexpected ACL on Copilot image temporary storage");
  }
}
