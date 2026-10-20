import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RemoteRuntime } from "../src/runtime.ts";
import { SshError } from "../src/domain.ts";
import { sudoIdentity } from "../src/sudo.ts";
import { CredentialDialogs, Dialogs } from "../src/ui.ts";
import type { Connection, ExecOptions } from "../src/transport.ts";
import { MemoryVault, temporary } from "./helpers.ts";

async function fixture() {
  const temp = await temporary(), vault = new MemoryVault();
  const previous = new RemoteRuntime(temp.directory, vault); await previous.load();
  const host = await previous.save({ name: "Recovery", hostname: "example.test", username: "tester", auth: "key", privateKeyPath: "/fixture/key" });
  const identity = sudoIdentity([host]);
  await previous.sudoCredentials.set(host.id, identity, "old-fixture-secret", true);
  previous.close();
  const file = path.join(temp.directory, "sudo-credentials.json");
  const original = await readFile(file, "utf8");
  const unavailable = () => new SshError("VAULT_UNAVAILABLE", "Fixture vault unavailable");
  vault.get = async () => { throw unavailable(); };
  vault.set = async () => { throw new Error("Recovery must not write to the vault"); };
  vault.delete = async () => { throw unavailable(); };
  const runtime = new RemoteRuntime(temp.directory, vault); await runtime.load();
  const dialogs = new Dialogs();
  const confirmations: string[] = [];
  let passwords = 0, commands = 0;
  const used: (string | undefined)[] = [];
  const answers: (string | undefined)[] = ["temporary-fixture-secret"];
  dialogs.password = async () => { passwords++; return answers.shift(); };
  let approve = true, headless = false, retry = false, unknown = false;
  const context = () => ({ mode: headless ? "print" : "tui", hasUI: !headless,
    ui: { select: async (title: string) => { confirmations.push(title.split("\n")[0]); return approve ? "Yes" : "No"; } },
  }) as unknown as ExtensionContext;
  const bridge = new CredentialDialogs(runtime, dialogs, context);
  const connection = { chain: [host], exec: async (_command: string, options: ExecOptions) => {
    commands++;
    const signal = new AbortController().signal;
    used.push(await options.sudo!(signal, false));
    if (retry) used.push(await options.sudo!(signal, true));
    return { elevated: !unknown, exitCode: unknown ? null : 0, outcome: unknown ? "unknown" : "exited" };
  } } as unknown as Connection;
  return {
    runtime, vault, host, identity, file, original, confirmations, used, answers,
    setOptions(options: { approve?: boolean; headless?: boolean; retry?: boolean; unknown?: boolean }) {
      approve = options.approve ?? approve; headless = options.headless ?? headless;
      retry = options.retry ?? retry; unknown = options.unknown ?? unknown;
    },
    counts: () => ({ passwords, commands }),
    run: () => runtime.execSudo("session", connection, "id -u", {}),
    close: async () => { bridge.close(); dialogs.close(); runtime.close(); await temp.close(); },
  };
}

test("unavailable remembered sudo credentials offer explicit temporary recovery and retain the stored reference", async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal((await f.run()).exitCode, 0);
  assert.deepEqual(f.confirmations, ["Use a temporary sudo credential?"]);
  assert.deepEqual(f.used, ["temporary-fixture-secret"]);
  assert.deepEqual(f.counts(), { passwords: 1, commands: 1 });
  assert.equal(await readFile(f.file, "utf8"), f.original);
  assert.equal(f.vault.values.size, 1);
  assert.equal(await f.runtime.sudoCredentials.get(f.host.id, f.identity), "temporary-fixture-secret");
  assert.equal(await f.runtime.sudoCredentials.get(f.host.id, "different-identity"), undefined);
  assert.ok(!JSON.stringify(f.runtime.state()).includes("temporary-fixture-secret"));
  await assert.rejects(f.runtime.sudoCredentials.remove(f.host.id), /unavailable/);
  assert.equal(await readFile(f.file, "utf8"), f.original);
  // Clearing also drops the runtime override, even when the old vault entry cannot be deleted.
  await assert.rejects(f.runtime.sudoCredentials.get(f.host.id, f.identity), /unavailable/);
  f.vault.get = async id => f.vault.values.get(id);
  f.vault.delete = async id => { f.vault.values.delete(id); };
  await f.runtime.sudoCredentials.remove(f.host.id);
  assert.equal(f.vault.values.size, 0);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), []);
});

for (const mode of ["declined", "headless", "password-cancelled"] as const) {
  test(`sudo vault recovery fails closed when ${mode}, preserving cancellation and cleanup references`, async t => {
    const f = await fixture(); t.after(f.close);
    f.setOptions({ approve: mode !== "declined", headless: mode === "headless" });
    if (mode === "password-cancelled") f.answers.splice(0);
    await assert.rejects(f.run(), { code: "CREDENTIAL_CANCELLED" });
    assert.equal(f.runtime.state().requests.length, 0);
    assert.equal(f.counts().passwords, mode === "password-cancelled" ? 1 : 0);
    assert.equal(f.confirmations.length, mode === "headless" ? 0 : 1);
    assert.equal(await readFile(f.file, "utf8"), f.original);
    assert.equal(f.used.length, 0);
  });
}

test("temporary sudo recovery retries inside the same command without losing old cleanup references", async t => {
  const f = await fixture(); t.after(f.close);
  f.answers.splice(0, 1, "wrong-fixture-secret", "corrected-fixture-secret");
  f.setOptions({ retry: true });
  assert.equal((await f.run()).exitCode, 0);
  assert.deepEqual(f.used, ["wrong-fixture-secret", "corrected-fixture-secret"]);
  assert.deepEqual(f.counts(), { passwords: 2, commands: 1 });
  assert.equal(await readFile(f.file, "utf8"), f.original);
});

test("vault cleanup cannot replace an unknown sudo command outcome", async t => {
  const f = await fixture(); t.after(f.close);
  f.setOptions({ unknown: true });
  const result = await f.run();
  assert.equal(result.outcome, "unknown");
  assert.equal(result.exitCode, null);
  assert.equal(f.counts().commands, 1);
  assert.equal(await readFile(f.file, "utf8"), f.original);
  await assert.rejects(f.runtime.sudoCredentials.get(f.host.id, f.identity), /unavailable/);
});
