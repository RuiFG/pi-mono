import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { dockerFixture } from "./docker.ts";
import { MemoryVault, temporary } from "./helpers.ts";
import { RemoteRuntime } from "../src/runtime.ts";
import { executeTool, type ToolName } from "../src/tools.ts";
import * as files from "../src/files.ts";
import { SshError, type HostProfile } from "../src/domain.ts";
import { sudoIdentity } from "../src/sudo.ts";
import { CredentialDialogs, Dialogs } from "../src/ui.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("real Linux OpenSSH integration", { skip: process.env.PI_REMOTE_SSH_INTEGRATION !== "1", timeout: 300_000 }, () => {
  let fixture: Awaited<ReturnType<typeof dockerFixture>>, temp: Awaited<ReturnType<typeof temporary>>, runtime: RemoteRuntime, host: HostProfile;
  // No UI or confirmation callback: all tools, including sudo and transfers, execute directly.
  const run = (name: ToolName, args: object, sessionId = "tools") => executeTool(name, { hostId: host.id, ...args }, { runtime, sessionId, cwd: temp.directory });
  before(async () => {
    fixture = await dockerFixture(); temp = await temporary();
    runtime = new RemoteRuntime(temp.directory, new MemoryVault()); await runtime.load();
    host = await runtime.save({ name: "Password server", hostname: "127.0.0.1", port: fixture.target.port, username: "tester", auth: "password" }, "fixture-password", false);
  });
  after(async () => { runtime?.close(); await temp?.close(); await fixture?.close(); });

  it("password login, working-directory validation, and directory changes are per host/session", async () => {
    const initial = await run("ssh_set_workspace", {}); assert.equal(initial.directory, "/home/tester");
    await assert.rejects(run("ssh_set_workspace", { path: "/missing-directory" }));
    assert.equal(runtime.resolve("tools", host.id).directory, "/home/tester");
    await run("ssh_mkdir", { path: "work/a", parents: true });
    await run("ssh_set_workspace", { path: "work/a" });
    const output = await run("ssh_shell_exec", { command: "pwd; cd /tmp; pwd" });
    assert.equal(output.stdout, "/home/tester/work/a\n/tmp\n");
    assert.equal(runtime.resolve("tools", host.id).directory, "/home/tester/work/a");
    await run("ssh_set_workspace", {}, "other");
    assert.equal(runtime.resolve("other", host.id).directory, "/home/tester");
  });
  it("plain keys, encrypted keys, and two nested jump hosts work", async () => {
    const key = await runtime.save({ name: "Key", hostname: "127.0.0.1", port: fixture.target.port, username: "tester", auth: "key", privateKeyPath: fixture.keyPath });
    assert.equal((await runtime.test(key.id)).exec, true);
    const jump = await runtime.save({ name: "Jump", hostname: "127.0.0.1", port: fixture.jump.port, username: "tester", auth: "password" }, "fixture-password", false);
    const encrypted = await runtime.save({ name: "Encrypted behind jump", hostname: "target", username: "tester", auth: "key", privateKeyPath: fixture.encryptedKeyPath, jumpHostId: jump.id }, "fixture-passphrase", false);
    assert.deepEqual((await runtime.test(encrypted.id)).hops, ["Jump", "Encrypted behind jump"]);
    const nested = await runtime.save({ name: "Nested", hostname: "jump", username: "tester", auth: "password", jumpHostId: encrypted.id }, "fixture-password", false);
    assert.equal((await runtime.test(nested.id)).hops.length, 3);
  });
  it("binary transfers stream 8 MiB, preserve conflicts, support Unicode and apostrophes", async () => {
    const bytes = randomBytes(8 * 1024 * 1024 + 3), source = path.join(temp.directory, "source.bin");
    await writeFile(source, bytes);
    await run("ssh_mkdir", { path: "data ' Unicode-字" });
    const remote = "data ' Unicode-字/payload.bin";
    await run("ssh_upload_file", { localPath: source, remotePath: remote });
    await assert.rejects(run("ssh_upload_file", { localPath: source, remotePath: remote }), /exists/);
    await run("ssh_download_file", { remotePath: remote, localPath: "download.bin" });
    const hash = (v: Buffer) => createHash("sha256").update(v).digest("hex");
    assert.equal(hash(await readFile(path.join(temp.directory, "download.bin"))), hash(bytes));
    await assert.rejects(run("ssh_download_file", { remotePath: remote, localPath: "download.bin" }), /exists/);
    await assert.rejects(run("ssh_read_file", { path: remote }), /Binary/);
    await run("ssh_write_file", { path: remote, content: "first\nsecond\nthird\n", overwrite: true });
    assert.equal((await run("ssh_read_file", { path: remote, startLine: 2, limit: 1 })).content, "second");
    await run("ssh_download_file", { remotePath: remote, localPath: "download.bin", overwrite: true });
    assert.equal(await readFile(path.join(temp.directory, "download.bin"), "utf8"), "first\nsecond\nthird\n");
    await assert.rejects(run("ssh_write_file", { path: "missing/parent/file", content: "x" }), /parent/);
    const connection = await runtime.connection("tools", host.id, false);
    const controller = new AbortController();
    await assert.rejects(files.upload(connection, source, "/home/tester/work/a/" + remote, true, controller.signal, () => controller.abort()));
    assert.equal((await run("ssh_read_file", { path: remote })).content, "first\nsecond\nthird");
  });
  it("glob, grep, move, listing and explicit recursive deletion work through tools", async () => {
    await run("ssh_mkdir", { path: "project/src/nested", parents: true });
    await run("ssh_write_file", { path: "project/src/nested/a.ts", content: "hello\nMATCH me\n" });
    assert.deepEqual((await run("ssh_glob", { path: "project", pattern: "src/**/*.ts" })).files, ["src/nested/a.ts"]);
    const grep = await run("ssh_grep", { path: "project", pattern: "MATCH", include: "*.ts" });
    assert.equal((grep.matches as string[]).length, 1);
    await run("ssh_move", { source: "project/src/nested/a.ts", destination: "project/src/nested/b.ts" });
    assert.equal(((await run("ssh_list_directory", { path: "project/src/nested" })).entries as { name: string }[])[0].name, "b.ts");
    await assert.rejects(run("ssh_delete", { path: "project" }));
    await run("ssh_delete", { path: "project", recursive: true });
  });
  it("two hosts execute concurrently with no implicit current target", async () => {
    const second = await runtime.save({ name: "Parallel", hostname: "127.0.0.1", port: fixture.jump.port, username: "tester", auth: "password" }, "fixture-password", false);
    await run("ssh_set_workspace", { path: "/tmp", hostId: second.id });
    const [a, b] = await Promise.all([run("ssh_shell_exec", { command: "pwd" }), run("ssh_shell_exec", { hostId: second.id, command: "pwd" })]);
    assert.equal(a.stdout, "/home/tester/work/a\n"); assert.equal(b.stdout, "/tmp\n");
    await runtime.disconnect("tools", second.id);
    await assert.rejects(run("ssh_shell_exec", { hostId: second.id, command: "pwd" }), /explicitly disconnected/);
    assert.equal((await run("ssh_shell_exec", { command: "pwd" })).ok, true);
    await run("ssh_set_workspace", { hostId: second.id });
    assert.equal(runtime.resolve("tools", second.id).directory, "/home/tester");
  });
  it("timeouts/cancellation do not replay, output is bounded and connections remain usable", async () => {
    const connection = await runtime.connection("execution", host.id, true);
    const timed = await connection.exec("printf once >> /home/tester/once; sleep 10", { timeoutMs: 100 });
    assert.equal(timed.timedOut, true); assert.equal((await connection.exec("cat /home/tester/once")).stdout, "once");
    const controller = new AbortController();
    const pending = connection.exec("sleep 10", { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    assert.equal((await pending).cancelled, true);
    const large = await connection.exec("head -c 1000000 /dev/zero", { maxBytes: 4096 });
    assert.equal(large.truncated, true); assert.equal(large.stdout.length, 4096);
    assert.equal((await connection.exec("printf alive")).stdout, "alive");
  });
  it("sudo separates stdin, handles wrong-password retry, NOPASSWD and never replays a failed command", async () => {
    const connection = await runtime.connection("sudo", host.id, true);
    let prompts = 0;
    const sudo = async () => { prompts++; return "fixture-password"; };
    const result = await connection.exec("cd /home/tester; cat > sudo-input; id -u | cat; cat sudo-input; printf diagnostic >&2", { sudo, stdin: "payload\n", timeoutMs: 15_000 });
    assert.equal(result.exitCode, 0); assert.equal(result.elevated, true); assert.equal(prompts, 1);
    assert.equal(result.stdout, "0\npayload\n"); assert.ok(result.stderr.endsWith("diagnostic"));
    assert.ok(!result.stderr.includes("fixture-password") && !result.stderr.includes("remote-ssh-root-"));
    let attempts = 0;
    assert.equal((await connection.exec("printf corrected", { sudo: async () => ++attempts === 1 ? "wrong" : "fixture-password" })).stdout, "corrected");
    assert.equal(attempts, 2);
    assert.equal((await connection.exec("printf once >> /home/tester/sudo-once; exit 7", { sudo })).exitCode, 7);
    assert.equal((await connection.exec("cat /home/tester/sudo-once")).stdout, "once");
    const nopass = await runtime.save({ name: "NOPASSWD", hostname: "127.0.0.1", port: fixture.target.port, username: "nopass", auth: "password" }, "fixture-password", false);
    const noPrompt = await run("ssh_shell_exec", { hostId: nopass.id, sudo: true, command: "id -u; cat", stdin: "input" });
    assert.equal(noPrompt.stdout, "0\ninput"); assert.equal(noPrompt.elevated, true);
  });
  it("remembered sudo vault failure recovers with an explicitly approved temporary password through real SSH", async () => {
    const isolated = await temporary(), vault = new MemoryVault();
    const initial = new RemoteRuntime(isolated.directory, vault);
    let recovered: RemoteRuntime | undefined, bridge: CredentialDialogs | undefined;
    const dialogs = new Dialogs();
    try {
      await initial.load();
      const key = await initial.save({ name: "Vault recovery", hostname: "127.0.0.1", port: fixture.target.port, username: "tester", auth: "key", privateKeyPath: fixture.keyPath });
      await initial.sudoCredentials.set(key.id, sudoIdentity([key]), "old-fixture-secret", true);
      initial.close();
      const file = path.join(isolated.directory, "sudo-credentials.json"), original = await readFile(file, "utf8");
      vault.get = async () => { throw new SshError("VAULT_UNAVAILABLE", "Fixture vault unavailable"); };
      vault.delete = async () => { throw new SshError("VAULT_UNAVAILABLE", "Fixture vault unavailable"); };
      vault.set = async () => { throw new Error("Recovery must not persist the replacement"); };
      recovered = new RemoteRuntime(isolated.directory, vault); await recovered.load();
      const titles: string[] = [], passwords = ["wrong-fixture-password", "fixture-password"];
      const ctx = { mode: "tui", hasUI: true, ui: { confirm: async (title: string) => { titles.push(title); return true; } } } as unknown as ExtensionContext;
      dialogs.password = async () => passwords.shift();
      bridge = new CredentialDialogs(recovered, dialogs, () => ctx);
      const marker = `/tmp/pi-vault-recovery-${key.id}`;
      const result = await executeTool("ssh_shell_exec", { hostId: key.id, sudo: true, command: `printf once >> '${marker}'; id -u; cat`, stdin: "separate-input\n", timeoutMs: 15_000 }, {
        runtime: recovered, sessionId: "recovery", cwd: isolated.directory,
      });
      assert.equal(result.ok, true); assert.equal(result.stdout, "0\nseparate-input\n");
      assert.equal(passwords.length, 0);
      assert.equal(titles.filter(title => title === "Use a temporary sudo credential?").length, 2);
      assert.ok(!titles.includes("Remember credential?"));
      const connection = await recovered.connection("recovery", key.id, false);
      assert.equal((await connection.exec(`cat '${marker}'`)).stdout, "once");
      assert.equal(await readFile(file, "utf8"), original);
      assert.ok(!JSON.stringify(result).includes("fixture-password"));
      assert.ok(!JSON.stringify(recovered.state()).includes("fixture-password"));
    } finally {
      bridge?.close(); dialogs.close(); initial.close(); recovered?.close(); await isolated.close();
    }
  });
  it("missing SFTP does not disable SSH execution", async () => {
    const noSftp = await runtime.save({ name: "No SFTP", hostname: "127.0.0.1", port: fixture.noSftp.port, username: "tester", auth: "password" }, "fixture-password", false);
    const result = await runtime.test(noSftp.id); assert.equal(result.exec, true); assert.equal(result.sftp, false);
    assert.equal((await run("ssh_shell_exec", { hostId: noSftp.id, command: "printf working" })).stdout, "working");
    await assert.rejects(run("ssh_list_directory", { hostId: noSftp.id }), /SFTP/);
  });
  it("network loss reconnects without replay; reset preserves the directory; active hosts cannot be removed", async () => {
    const old = await runtime.connection("tools", host.id, false); old.close();
    assert.equal((await run("ssh_shell_exec", { command: "pwd" })).stdout, "/home/tester/work/a\n");
    await run("ssh_reset_connection", {});
    assert.equal(runtime.resolve("tools", host.id).directory, "/home/tester/work/a");
    await assert.rejects(runtime.deleteHost(host.id), /in use/);
    const fresh = new RemoteRuntime(temp.directory, new MemoryVault()); await fresh.load();
    try {
      assert.equal(fresh.resolve("tools", host.id).directory, undefined);
      assert.ok(fresh.state("tools").hosts.every(h => h.status === "disconnected"));
      assert.equal(await fresh.credentials.get(host.credentialId, false), undefined);
    } finally { fresh.close(); }
  });
});
