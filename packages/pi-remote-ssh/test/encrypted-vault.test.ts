import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir, rm, stat, symlink, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Credentials, EncryptedFileSecrets } from "../src/credentials.ts";
import { RemoteRuntime } from "../src/runtime.ts";
import { sudoIdentity } from "../src/sudo.ts";
import { temporary } from "./helpers.ts";

const secret = "fixture-password-秘密-not-a-real-credential";

test("encrypted file credentials survive fresh runtimes without an OS credential service", async t => {
  const temp = await temporary(); t.after(temp.close);
  const runtime = new RemoteRuntime(temp.directory); await runtime.load();
  const host = await runtime.save({ name: "Encrypted", hostname: "fixture.test", username: "tester", auth: "password" }, secret, true);
  await runtime.sudoCredentials.set(host.id, sudoIdentity([host]), `${secret}-sudo`, true);
  runtime.close();
  const fresh = new RemoteRuntime(temp.directory); await fresh.load(); t.after(() => fresh.close());
  assert.equal(await fresh.credentials.get(host.credentialId, true), secret);
  assert.equal(await fresh.sudoCredentials.get(host.id, sudoIdentity([host])), `${secret}-sudo`);
  const directory = path.join(temp.directory, "credentials");
  assert.deepEqual((await readdir(directory)).sort(), ["key", "vault.json"]);
  assert.equal((await readFile(path.join(directory, "key"))).length, 32);
  for (const file of [path.join(directory, "vault.json"), path.join(temp.directory, "hosts.json")]) {
    assert.ok(!(await readFile(file)).includes(Buffer.from(secret)));
  }
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const file of ["key", "vault.json"]) assert.equal((await stat(path.join(directory, file))).mode & 0o777, 0o600);
  }
  await fresh.deleteHost(host.id);
  assert.equal(await new EncryptedFileSecrets(directory).get(host.credentialId!), undefined);
});

test("legacy credential references are not mistaken for encrypted-file entries or deleted silently", async t => {
  const temp = await temporary(); t.after(temp.close);
  const vault = new EncryptedFileSecrets(temp.directory), oldId = randomUUID(), nextId = randomUUID();
  const legacy = path.join(temp.directory, `${oldId}.dpapi`);
  await writeFile(legacy, "fixture-legacy-ciphertext");
  assert.equal(await vault.get(oldId), undefined);
  await vault.set(nextId, secret); await vault.delete(oldId);
  assert.equal(await vault.get(nextId), secret);
  assert.equal(await readFile(legacy, "utf8"), "fixture-legacy-ciphertext");
});

test("memory-only credentials create no credential files", async t => {
  const temp = await temporary(); t.after(temp.close);
  const directory = path.join(temp.directory, "credentials");
  const credentials = new Credentials(new EncryptedFileSecrets(directory));
  const ref = await credentials.create(secret, false);
  assert.equal(await credentials.get(ref.id, false), secret);
  credentials.clear();
  assert.equal(await credentials.get(ref.id, false), undefined);
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("independent encrypted vault writers share one key and preserve concurrent changes", async t => {
  const temp = await temporary(); t.after(temp.close);
  const ids = Array.from({ length: 8 }, () => randomUUID());
  await Promise.all(ids.map((id, index) => new EncryptedFileSecrets(temp.directory).set(id, `${secret}-${index}`)));
  const key = await readFile(path.join(temp.directory, "key"));
  const vault = new EncryptedFileSecrets(temp.directory);
  for (const [index, id] of ids.entries()) assert.equal(await vault.get(id), `${secret}-${index}`);
  await Promise.all([vault.delete(ids[0]), new EncryptedFileSecrets(temp.directory).set(ids[1], "updated")]);
  assert.equal(await vault.get(ids[0]), undefined);
  assert.equal(await vault.get(ids[1]), "updated");
  assert.deepEqual(await readFile(path.join(temp.directory, "key")), key);
});

for (const damage of ["ciphertext", "tag", "nonce", "version", "invalid-json", "key-missing", "key-corrupt", "key-truncated"] as const) {
  test(`damaged or missing ${damage} fails closed without replacing the vault or key`, async t => {
    const temp = await temporary(); t.after(temp.close);
    const vault = new EncryptedFileSecrets(temp.directory), id = randomUUID();
    await vault.set(id, secret);
    const file = path.join(temp.directory, "vault.json"), keyFile = path.join(temp.directory, "key");
    if (damage === "key-missing") await rm(keyFile);
    else if (damage === "key-corrupt") await writeFile(keyFile, Buffer.alloc(32));
    else if (damage === "key-truncated") await writeFile(keyFile, Buffer.alloc(3));
    else if (damage === "invalid-json") await writeFile(file, "{broken");
    else {
      const envelope = JSON.parse(await readFile(file, "utf8"));
      if (damage === "version") envelope.version = 999;
      else {
        const bytes = Buffer.from(envelope[damage], "base64"); bytes[0] ^= 1;
        envelope[damage] = bytes.toString("base64");
      }
      await writeFile(file, JSON.stringify(envelope));
    }
    const before = await readFile(file);
    const keyBefore = await readFile(keyFile).catch(() => undefined);
    await assert.rejects(vault.get(id), { code: "VAULT_UNAVAILABLE" });
    await assert.rejects(vault.set(randomUUID(), "replacement"), { code: "VAULT_UNAVAILABLE" });
    await assert.rejects(vault.delete(id), { code: "VAULT_UNAVAILABLE" });
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readFile(keyFile).catch(() => undefined), keyBefore);
  });
}

test("identical passwords use fresh encryption nonces and invalid credential IDs are rejected", async t => {
  const temp = await temporary(); t.after(temp.close);
  const vault = new EncryptedFileSecrets(temp.directory), id = randomUUID();
  await vault.set(id, secret);
  const before = JSON.parse(await readFile(path.join(temp.directory, "vault.json"), "utf8"));
  await vault.set(id, secret);
  const after = JSON.parse(await readFile(path.join(temp.directory, "vault.json"), "utf8"));
  assert.notEqual(before.nonce, after.nonce);
  assert.notEqual(before.ciphertext, after.ciphertext);
  for (const operation of [() => vault.get("../outside"), () => vault.set("../outside", secret), () => vault.delete("../outside")]) {
    await assert.rejects(operation(), { code: "INVALID_CREDENTIAL_ID" });
  }
});

test("separate processes can concurrently save and later unlock without a password prompt", async t => {
  const temp = await temporary(); t.after(temp.close);
  const ids = Array.from({ length: 3 }, () => randomUUID());
  const exec = promisify(execFile);
  const source = `
    const { EncryptedFileSecrets } = await import(process.argv[1]);
    const vault = new EncryptedFileSecrets(process.argv[2]), id = process.argv[3];
    if (process.argv[4] === 'write') await vault.set(id, 'fixture-' + id);
    else {
      if (await vault.get(id) !== 'fixture-' + id) throw new Error('Credential round-trip failed');
      await vault.delete(id);
      if (await vault.get(id) !== undefined) throw new Error('Credential deletion failed');
    }
  `;
  const run = (id: string, mode: string) => exec(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", source,
    new URL("../src/credentials.ts", import.meta.url).href, temp.directory, id, mode], { timeout: 15_000 });
  const results = await Promise.allSettled(ids.map(id => run(id, "write")));
  for (const result of results) assert.equal(result.status, "fulfilled");
  for (const id of ids) await run(id, "read-delete");
});

test("overly permissive key files fail closed without rewriting existing data", { skip: process.platform === "win32" }, async t => {
  const temp = await temporary(); t.after(temp.close);
  const vault = new EncryptedFileSecrets(temp.directory), id = randomUUID();
  await vault.set(id, secret);
  const file = path.join(temp.directory, "vault.json"), before = await readFile(file);
  await chmod(path.join(temp.directory, "key"), 0o644);
  await assert.rejects(vault.get(id), { code: "VAULT_UNAVAILABLE" });
  await assert.rejects(vault.set(randomUUID(), "replacement"), { code: "VAULT_UNAVAILABLE" });
  assert.deepEqual(await readFile(file), before);
});

test("a symlinked key is rejected rather than reading a file outside the vault", { skip: process.platform === "win32" }, async t => {
  const temp = await temporary(); t.after(temp.close);
  const directory = path.join(temp.directory, "vault"), id = randomUUID();
  const vault = new EncryptedFileSecrets(directory); await vault.set(id, secret);
  const keyFile = path.join(directory, "key"), outside = path.join(temp.directory, "outside");
  await writeFile(outside, await readFile(keyFile)); await rm(keyFile); await symlink(outside, keyFile);
  await assert.rejects(vault.get(id), { code: "VAULT_UNAVAILABLE" });
});
