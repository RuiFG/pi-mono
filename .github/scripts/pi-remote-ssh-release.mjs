import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const name = "pi-remote-ssh";
const registry = "https://registry.npmjs.org/";

export function releaseMetadata(pkg, ref) {
  assert.equal(pkg.name, name, "Only pi-remote-ssh may be released by this workflow");
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/, "Unsupported release version");
  assert.equal(pkg.version, pkg.version.trim(), "Release version must not contain surrounding whitespace");
  assert.notEqual(pkg.private, true, "Package is private");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.publishConfig?.registry, registry);
  assert.equal(pkg.publishConfig?.access, "public");
  const tag = `${name}-v${pkg.version}`;
  if (ref.startsWith("refs/tags/")) assert.equal(ref, `refs/tags/${tag}`, "Tag and package version differ");
  return { name, version: pkg.version, tag, npm_tag: pkg.version.includes("-") ? "next" : "latest", prerelease: pkg.version.includes("-") };
}

export function verifyArtifact(metadata, pack, bytes) {
  assert.equal(pack.name, metadata.name);
  assert.equal(pack.version, metadata.version);
  assert.equal(pack.filename, `${metadata.name}-${metadata.version}.tgz`);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(pack.integrity, integrity, "Artifact integrity mismatch");
  assert.deepEqual(pack.bundled, [], "Dependencies must not be bundled");
  const files = pack.files.map(file => file.path);
  for (const required of ["index.ts", "package.json", "LICENSE", "NOTICE.md", "README.md"]) assert.ok(files.includes(required), `Missing ${required}`);
  assert.ok(files.every(file => ["index.ts", "package.json", "LICENSE", "NOTICE.md", "README.md"].includes(file) || /^src\/[A-Za-z0-9-]+\.ts$/.test(file)), "Unexpected published file");
  return { ...metadata, filename: pack.filename, integrity };
}

export function registryState(artifact, status, body, allowMissing) {
  if (status === 404 && allowMissing) return "missing";
  assert.equal(status, 200, `Unexpected npm registry response: ${status}`);
  assert.equal(body.name, artifact.name);
  assert.equal(body.version, artifact.version);
  assert.equal(body.dist?.integrity, artifact.integrity, "Version already exists with a different artifact; do not overwrite or reuse a release tag");
  return "published";
}

async function main() {
  const [command, directory] = process.argv.slice(2);
  assert.ok(["metadata", "artifact", "check-registry", "verify-registry"].includes(command), "Unknown release command");
  const pkg = JSON.parse(await readFile("packages/pi-remote-ssh/package.json", "utf8"));
  const metadata = releaseMetadata(pkg, process.env.GITHUB_REF ?? "");
  let result = metadata;
  if (command !== "metadata") {
    assert.ok(directory, "Artifact directory is required");
    const packs = JSON.parse(await readFile(path.join(directory, "pack.json"), "utf8"));
    assert.equal(packs.length, 1);
    // Validate the basename before accessing a downloaded artifact path.
    assert.equal(packs[0].filename, `${metadata.name}-${metadata.version}.tgz`);
    result = verifyArtifact(metadata, packs[0], await readFile(path.join(directory, packs[0].filename)));
    if (command.endsWith("registry")) {
      const response = await fetch(`${registry}${metadata.name}/${metadata.version}`, { signal: AbortSignal.timeout(30_000), headers: { "Cache-Control": "no-cache" } });
      const body = response.ok ? await response.json() : undefined;
      result = { ...result, state: registryState(result, response.status, body, command === "check-registry") };
    }
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
