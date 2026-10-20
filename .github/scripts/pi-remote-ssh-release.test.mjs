import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { releaseMetadata, verifyArtifact, registryState } from "./pi-remote-ssh-release.mjs";

const pkg = { name: "pi-remote-ssh", version: "0.1.1", license: "MIT", publishConfig: { access: "public", registry: "https://registry.npmjs.org/" } };
const metadata = releaseMetadata(pkg, "refs/tags/pi-remote-ssh-v0.1.1");
const bytes = Buffer.from("fixture artifact bytes");
const pack = {
  name: pkg.name, version: pkg.version, filename: "pi-remote-ssh-0.1.1.tgz", bundled: [],
  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  files: ["index.ts", "package.json", "LICENSE", "NOTICE.md", "README.md", "src/tools.ts"].map(path => ({ path })),
};

test("stable releases use latest and prereleases use next", () => {
  assert.equal(metadata.npm_tag, "latest"); assert.equal(metadata.prerelease, false);
  const prerelease = releaseMetadata({ ...pkg, version: "0.2.0-beta.1" }, "refs/tags/pi-remote-ssh-v0.2.0-beta.1");
  assert.equal(prerelease.npm_tag, "next"); assert.equal(prerelease.prerelease, true);
});

test("release tag must match the package version; branch runs can validate metadata", () => {
  assert.throws(() => releaseMetadata(pkg, "refs/tags/pi-remote-ssh-v9.0.0"), /differ/);
  assert.throws(() => releaseMetadata(pkg, "refs/tags/other-v0.1.1"), /differ/);
  assert.equal(releaseMetadata(pkg, "refs/heads/main").version, "0.1.1");
});

test("root/private packages, unexpected names, registries and unsafe versions fail closed", () => {
  for (const change of [{ private: true }, { name: "pi-mono" }, { license: "UNLICENSED" }, { publishConfig: { access: "restricted" } }]) {
    assert.throws(() => releaseMetadata({ ...pkg, ...change }, "refs/heads/main"));
  }
  for (const version of ["../x", "0.1.1\n", "0.1.1\nstate=published", "0.1.1;echo", "01.1.1", "0.1.1-beta..1"]) {
    assert.throws(() => releaseMetadata({ ...pkg, version }, "refs/heads/main"));
  }
});

test("the published artifact must have exact metadata, bytes, license and allowed files", () => {
  const artifact = verifyArtifact(metadata, pack, bytes);
  assert.equal(artifact.integrity, pack.integrity);
  assert.throws(() => verifyArtifact(metadata, pack, Buffer.from("different bytes")), /integrity/);
  assert.throws(() => verifyArtifact(metadata, { ...pack, filename: "../artifact.tgz" }, bytes));
  assert.throws(() => verifyArtifact(metadata, { ...pack, version: "9.9.9" }, bytes));
  assert.throws(() => verifyArtifact(metadata, { ...pack, bundled: ["unexpected"] }, bytes));
  assert.throws(() => verifyArtifact(metadata, { ...pack, files: pack.files.filter(file => file.path !== "LICENSE") }, bytes), /Missing LICENSE/);
  for (const file of [".npmrc", "test/fixture.ts", "node_modules/x.js", "src/../secret.ts"]) {
    assert.throws(() => verifyArtifact(metadata, { ...pack, files: [...pack.files, { path: file }] }, bytes), /Unexpected/);
  }
});

test("only a confirmed registry 404 permits publication; authentication/server failures do not", () => {
  const artifact = verifyArtifact(metadata, pack, bytes);
  assert.equal(registryState(artifact, 404, undefined, true), "missing");
  for (const status of [401, 403, 429, 500]) assert.throws(() => registryState(artifact, status, undefined, true));
  assert.throws(() => registryState(artifact, 404, undefined, false));
});

test("reruns accept only the identical published version and reject conflicting artifacts", () => {
  const artifact = verifyArtifact(metadata, pack, bytes);
  const published = { name: pkg.name, version: pkg.version, dist: { integrity: pack.integrity } };
  assert.equal(registryState(artifact, 200, published, true), "published");
  assert.equal(registryState(artifact, 200, published, false), "published");
  assert.throws(() => registryState(artifact, 200, { ...published, dist: { integrity: "different" } }, true), /different artifact/);
  assert.throws(() => registryState(artifact, 200, { ...published, name: "another-package" }, true));
});
