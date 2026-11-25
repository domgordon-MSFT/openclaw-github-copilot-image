import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultCli, hashFile, runtimeTarget, version } from "../trusted-runtime.mjs";

const target = runtimeTarget();
if (process.getuid() !== 0) throw new Error("Run the credential-free runtime installer as root");
const dest = dirname(defaultCli);
const parent = dirname(dest);
await mkdir(parent, { mode: 0o755, recursive: true });
const parentStat = await lstat(parent);
if (parentStat.uid !== 0 || (parentStat.mode & 0o022) || await realpath(parent) !== parent) {
  throw new Error("Expected a protected runtime installation parent");
}
const lock = `${dest}.installing`;
await mkdir(lock, { mode: 0o700 });
let temp;
try {
  try {
    await lstat(dest);
    throw new Error(`Runtime already exists at ${dest}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  temp = await mkdtemp(join(parent, ".copilot-image-runtime-"));
  const npm = `@github/copilot-${target.key}@${version}`;
  const archive = join(temp, `github-copilot-${target.key}-${version}.tgz`);
  const staging = join(temp, "runtime"), home = join(temp, "home");
  const cache = join(staging, "cache"), cli = join(staging, "copilot");
  const cleanEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: home };
  await mkdir(staging, { mode: 0o755 });
  await mkdir(home, { mode: 0o700 });
  await mkdir(cache, { mode: 0o755 });
  execFileSync("npm", ["pack", "--silent", "--ignore-scripts", "--registry=https://registry.npmjs.org", npm],
    { cwd: temp, env: cleanEnv, stdio: "inherit" });
  if (`sha512-${await hashFile(archive, "sha512", "base64")}` !== target.archiveIntegrity) throw new Error("Copilot archive integrity mismatch");
  execFileSync("/usr/bin/tar", ["-xzf", archive, "--no-same-owner", "--strip-components=1", "-C", staging]);
  if (await hashFile(cli, "sha256", "hex") !== target.executableSha256) throw new Error("Copilot executable integrity mismatch");
  await chmod(cli, 0o755);
  execFileSync(cli, ["help", "environment"], { cwd: home, env: {
    HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin", COPILOT_AUTO_UPDATE: "false", COPILOT_CACHE_HOME: cache,
  } });
  if (!(await lstat(join(cache, "pkg", target.key, version))).isDirectory()) throw new Error("Missing extracted Copilot distribution");
  await protect(staging);
  await rename(staging, dest);
  console.log(`Installed verified Copilot CLI ${version} (${target.key}) at ${dest}`);
} finally {
  if (temp) await rm(temp, { recursive: true, force: true });
  await rmdir(lock);
}

async function protect(path) {
  const st = await lstat(path);
  if (st.uid !== 0 || (!st.isDirectory() && !st.isFile())) throw new Error("Unexpected entry in Copilot runtime directory");
  await chmod(path, st.isDirectory() || (st.mode & 0o111) ? 0o755 : 0o644);
  if (st.isDirectory()) for (const entry of await readdir(path)) await protect(join(path, entry));
}
