import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Profiles, HostKeys } from "../src/storage.ts";
import { Credentials } from "../src/credentials.ts";
import { RemoteRuntime } from "../src/runtime.ts";
import { remotePath, quote } from "../src/paths.ts";
import type { Connection, Connector } from "../src/transport.ts";
import type { HostProfile } from "../src/domain.ts";
import { PasswordInput } from "../src/password.ts";
import { schemas, executeTool, registerTools, toolResult, READ_ONLY } from "../src/tools.ts";
import { CredentialDialogs, Dialogs } from "../src/ui.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MemoryVault, temporary } from "./helpers.ts";

const draft = { name: "Development", hostname: "dev.example.test", username: "dev", auth: "password" as const };

test("host IDs survive rename, duplicate names and jump cycles are rejected", async t => {
  const temp = await temporary(); t.after(temp.close);
  const profiles = new Profiles(path.join(temp.directory, "hosts.json")); await profiles.load();
  const first = await profiles.save(draft);
  const second = await profiles.save({ ...draft, name: "Jump", jumpHostId: first.id });
  await assert.rejects(profiles.save({ ...draft, name: "development" }), /unique/);
  await assert.rejects(profiles.save({ ...draft, id: first.id, jumpHostId: second.id }), /cycle/);
  const renamed = await profiles.save({ ...draft, id: first.id, name: "Renamed" });
  assert.equal(renamed.id, first.id);
  assert.equal(renamed.revision, first.revision);
  assert.deepEqual(profiles.chain(second.id).map(h => h.id), [first.id, second.id]);
  await assert.rejects(profiles.remove(first.id), /jump host/);
});

test("independent profile writers do not lose hosts; independent pin writers cannot accept conflicting keys", async t => {
  const temp = await temporary(); t.after(temp.close);
  const file = path.join(temp.directory, "hosts.json");
  const a = new Profiles(file), b = new Profiles(file); await Promise.all([a.load(), b.load()]);
  await Promise.all([a.save(draft), b.save({ ...draft, name: "Second" })]);
  await a.load(); assert.equal(a.list().length, 2);
  const keys = [new HostKeys(path.join(temp.directory, "keys.json")), new HostKeys(path.join(temp.directory, "keys.json"))];
  await Promise.all(keys.map(k => k.load()));
  const results = await Promise.allSettled(keys.map((k, i) => k.verify({ hostname: "same", port: 22 }, Buffer.from(String(i)))));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
});

test("credential persistence is opt-in, vault errors never fall back to plaintext, endpoint edits discard old secrets", async t => {
  const temp = await temporary(); t.after(temp.close);
  const vault = new MemoryVault(), runtime = new RemoteRuntime(temp.directory, vault); await runtime.load(); t.after(() => runtime.close());
  const host = await runtime.save(draft, "private-test-value", false);
  assert.ok(!(await readFile(path.join(temp.directory, "hosts.json"), "utf8")).includes("private-test-value"));
  assert.equal(await new Credentials(vault).get(host.credentialId, false), undefined);
  vault.set = async () => { throw new Error("Vault locked"); };
  await assert.rejects(runtime.save({ ...draft, name: "Failed" }, "secret", true), /locked/);
  assert.equal(runtime.profiles.list().length, 1);
  await runtime.save({ ...draft, id: host.id, hostname: "changed.example.test" });
  assert.equal(runtime.profiles.get(host.id).credentialId, undefined);
  runtime.close();
  assert.equal(await runtime.credentials.get(host.credentialId, false), undefined);
});

test("paths follow remote Linux rules and shell quoting cannot interpolate", () => {
  assert.equal(remotePath("../logs/a b", "/srv/project", "/home/dev"), "/srv/logs/a b");
  assert.equal(remotePath("~/src", "/srv/project", "/home/dev"), "/home/dev/src");
  assert.equal(quote("a'b;$HOME"), "'a'\\''b;$HOME'");
  assert.throws(() => remotePath("~root", "/", "/home/dev"));
  assert.throws(() => quote("bad\0value"));
});

test("ordinary commands and NOPASSWD sudo execute without an approval channel, including in a new session", async t => {
  const temp = await temporary(); t.after(temp.close);
  const commands: string[] = [];
  const connector = { connect: async (chain: HostProfile[]) => ({
    chain, alive: true, home: "/home/tester", sftpAvailable: true,
    onClose() {}, close() {}, directory: async (directory: string) => directory,
    exec: async (command: string) => { commands.push(command); return { stdout: "done", stderr: "", exitCode: 0, outcome: "exited", elevated: true }; },
  }) as unknown as Connection } as unknown as Connector;
  const runtime = new RemoteRuntime(temp.directory, new MemoryVault(), connector); await runtime.load(); t.after(() => runtime.close());
  const host = await runtime.save(draft);
  for (const sessionId of ["headless", "new-session"]) {
    const env = { runtime, sessionId, cwd: temp.directory };
    assert.equal((await executeTool("ssh_shell_exec", { hostId: host.id, command: "id" }, env)).ok, true);
    assert.equal((await executeTool("ssh_shell_exec", { hostId: host.id, command: "id -u", sudo: true }, env)).ok, true);
  }
  assert.equal(commands.length, 4);
  // A connection established under a different identity is still rejected before execution.
  const originalConnect = runtime.connection.bind(runtime);
  runtime.connection = async (...args) => {
    const connection = await originalConnect(...args);
    return { ...connection, chain: [{ ...host, hostname: "changed.test" }] } as Connection;
  };
  await assert.rejects(executeTool("ssh_shell_exec", { hostId: host.id, command: "id" }, { runtime, sessionId: "headless", cwd: temp.directory }), { code: "HOST_CHANGED" });
  assert.equal(commands.length, 4);
});

test("cancelled operations fail before opening connections; discovery redacts credentials and IDs are mandatory", async t => {
  const temp = await temporary(); t.after(temp.close);
  const runtime = new RemoteRuntime(temp.directory, new MemoryVault()); await runtime.load(); t.after(() => runtime.close());
  const host = await runtime.save(draft, "private-test-password", false);
  const env = { runtime, sessionId: "headless", cwd: temp.directory };
  const controller = new AbortController(); controller.abort();
  for (const [name, args] of [
    ["ssh_shell_exec", { command: "id" }], ["ssh_write_file", { path: "a", content: "x" }],
    ["ssh_reset_connection", {}], ["ssh_download_file", { remotePath: "a", localPath: "b" }],
  ] as const) await assert.rejects(executeTool(name, { hostId: host.id, ...args }, { ...env, signal: controller.signal }), /cancelled/);
  assert.equal(runtime.state("headless").hosts[0].status, "disconnected");
  const list = JSON.stringify(await executeTool("ssh_list_hosts", {}, env));
  assert.ok(!list.includes("credentialId") && !list.includes("private-test-password"));
  assert.throws(() => schemas.ssh_shell_exec.parse({ command: "id" }));
  assert.throws(() => schemas.ssh_shell_exec.parse({ hostId: host.name, command: "id" }));
  assert.throws(() => schemas.ssh_list_hosts.parse({ password: "secret" }));
  assert.equal(schemas.ssh_shell_exec.parse({ hostId: host.id, command: "id" }).timeoutMs, 120_000);
});

test("password input masks typing/paste, handles Unicode backspace and clearing, never renders secrets", () => {
  let result: string | undefined;
  const input = new PasswordInput("SSH password", value => { result = value; }, () => {});
  input.handleInput("sensitive"); input.handleInput("\x1b[200~🗝字\x1b[201~");
  for (const width of [10, 40, 100]) assert.ok(!input.render(width).join().includes("sensitive"));
  input.handleInput("\x7f"); input.handleInput("\r");
  assert.equal(result, "sensitive🗝");
  const clear = new PasswordInput("Secret", value => { result = value; }, () => {});
  clear.handleInput("secret"); clear.handleInput("\x15"); clear.handleInput("new"); clear.handleInput("\r");
  assert.equal(result, "new");
  const cancel = new PasswordInput("Secret", value => { result = value; }, () => {});
  cancel.handleInput("secret"); cancel.handleInput("\x1b"); assert.equal(result, undefined);
});

test("all 10 tools register English descriptions, explicit schemas, hints and bounded error results", () => {
  const tools: ToolDefinition[] = [];
  const pi = { registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI;
  registerTools(pi, async () => { throw new Error("unused"); });
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "ssh_list_hosts", "ssh_set_workspace", "ssh_shell_exec", "ssh_read_file", "ssh_write_file",
    "ssh_grep", "ssh_glob", "ssh_upload_file", "ssh_download_file", "ssh_reset_connection",
  ].sort());
  for (const removed of ["ssh_mkdir", "ssh_delete", "ssh_move", "ssh_list_directory"]) {
    assert.ok(!Object.hasOwn(schemas, removed));
    assert.ok(!tools.some(tool => tool.name === removed));
  }
  for (const tool of tools) {
    assert.ok(!/[\u4e00-\u9fff]/.test(tool.description));
    assert.equal(tool.annotations?.readOnlyHint, READ_ONLY.has(tool.name as keyof typeof schemas));
    if (tool.name !== "ssh_list_hosts") assert.ok((tool.parameters as unknown as { required: string[] }).required.includes("hostId"));
  }
  const failed = toolResult({ ok: false, error: "Declined" }); assert.equal(failed.isError, true);
  for (const stdout of ["x".repeat(500_000), "\\\"\n".repeat(200_000)]) {
    const large = toolResult({ ok: false, stdout, outcome: "unknown", exitCode: null, timedOut: true });
    assert.equal(large.details.truncated, true);
    assert.equal(large.details.outcome, "unknown");
    assert.equal(large.details.timedOut, true);
    assert.ok(Buffer.byteLength(large.content[0].text) < 64 * 1024);
  }
});

test("credential requests fail promptly without an interactive terminal", async t => {
  const temp = await temporary(); t.after(temp.close);
  const runtime = new RemoteRuntime(temp.directory, new MemoryVault()); await runtime.load(); t.after(() => runtime.close());
  const dialogs = new Dialogs(); t.after(() => dialogs.close());
  const bridge = new CredentialDialogs(runtime, dialogs, () => ({ mode: "print", hasUI: false } as ExtensionContext));
  t.after(() => bridge.close());
  const host = await runtime.save(draft);
  await assert.rejects(runtime.connection("s", host.id, true), /cancelled/);
  assert.equal(runtime.state().requests.length, 0);
});
