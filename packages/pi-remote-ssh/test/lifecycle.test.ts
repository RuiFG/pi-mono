import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Credentials } from "../src/credentials.ts";
import { SudoCredentials } from "../src/sudo.ts";
import { MemoryVault, temporary } from "./helpers.ts";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

test("shutdown during a vault write cannot repopulate temporary secrets or orphan a new remembered secret", async () => {
  const vault = new MemoryVault(), wait = gate();
  vault.set = async (id, value) => { await wait.promise; vault.values.set(id, value); };
  const credentials = new Credentials(vault);
  const pending = credentials.create("fixture-secret", true);
  const rejected = assert.rejects(pending, /shutdown/);
  credentials.clear(); wait.open(); await rejected;
  assert.equal(vault.values.size, 0);
  await assert.rejects(credentials.create("later", false), /closed/);
});

test("shutdown during a vault read does not cache or return the late secret", async () => {
  const vault = new MemoryVault(), wait = gate();
  vault.get = async () => { await wait.promise; return "fixture-secret"; };
  const credentials = new Credentials(vault);
  const pending = credentials.get("test-id", true);
  credentials.clear(); wait.open();
  assert.equal(await pending, undefined);
  assert.equal(await credentials.get("test-id", true), undefined);
});

test("failed sudo vault deletion remains visible and keeps references so clearing can be retried", async t => {
  const temp = await temporary(); t.after(temp.close);
  const vault = new MemoryVault(), credentials = new Credentials(vault);
  const file = path.join(temp.directory, "sudo.json");
  const store = new SudoCredentials(file, credentials); await store.load();
  await store.set("host", "identity", "fixture-secret", true);
  vault.delete = async () => { throw new Error("Vault locked"); };
  await assert.rejects(store.remove("host"), /locked/);
  const reloaded = new SudoCredentials(file, new Credentials(vault)); await reloaded.load();
  assert.equal(await reloaded.get("host", "identity"), "fixture-secret");
  vault.delete = async id => { vault.values.delete(id); };
  await reloaded.remove("host"); assert.equal(vault.values.size, 0);
});
