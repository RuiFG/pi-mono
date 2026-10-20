import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { temporary } from "./helpers.ts";
import { smoke } from "./sdk-smoke.ts";

const exec = promisify(execFile);
const temp = await temporary();
const root = fileURLToPath(new URL("../", import.meta.url));
const npm = async (args: string[], cwd: string) => {
  const command = process.env.npm_execpath ? process.execPath : "npm";
  const argv = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
  return (await exec(command, argv, { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
};
try {
  const output = await npm(["pack", "--json", "--ignore-scripts", "--pack-destination", temp.directory], root);
  const packed = JSON.parse(output) as { filename: string; files: { path: string }[] }[];
  assert.equal(packed.length, 1);
  const files = packed[0].files.map(file => file.path);
  for (const file of ["index.ts", "src/tools.ts", "src/transport.ts", "src/password.ts", "README.md", "NOTICE.md"]) assert.ok(files.includes(file), file);
  assert.ok(files.every(file => !file.startsWith("test/") && !file.startsWith("node_modules/") && !file.endsWith(".tgz")));
  const consumer = path.join(temp.directory, "consumer"); await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), '{"name":"pi-ssh-package-test","private":true}');
  await npm(["install", path.join(temp.directory, packed[0].filename), "--omit=dev", "--omit=optional", "--legacy-peer-deps", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], consumer);
  await assert.rejects(access(path.join(consumer, "node_modules/@earendil-works/pi-coding-agent")), { code: "ENOENT" });
  await assert.rejects(access(path.join(consumer, "node_modules/@napi-rs/keyring")), { code: "ENOENT" });
  await smoke(path.join(consumer, "node_modules/pi-remote-ssh/index.ts"), process.platform !== "win32");
  console.log(`PASS: isolated packed installation (${files.length} files), runtime dependencies only, host peers not bundled, optional vault absent`);
} finally { await temp.close(); }
