import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostProfile } from "../src/domain.ts";
import { RemoteRuntime } from "../src/runtime.ts";
import { executeTool } from "../src/tools.ts";
import type { Connection, Connector } from "../src/transport.ts";
import { Dialogs, hostMenu } from "../src/ui.ts";
import { MemoryVault, temporary } from "./helpers.ts";

async function fixture() {
  const temp = await temporary();
  const connections: Connection[] = [];
  const connector = { connect: async (chain: HostProfile[]) => {
    let alive = true;
    const connection = { chain, get alive() { return alive; }, home: "/home/tester", sftpAvailable: true,
      directory: async (directory: string) => directory,
      onClose() {}, close() { alive = false; },
    } as unknown as Connection;
    connections.push(connection); return connection;
  } } as unknown as Connector;
  const runtime = new RemoteRuntime(temp.directory, new MemoryVault(), connector);
  await runtime.load();
  const host = await runtime.save({ name: "Menu host", hostname: "menu.test", username: "tester", auth: "password" });
  const dialogs = new Dialogs();
  const menus: string[][] = [], notifications: { message: string; type: string }[] = [];
  const confirmations: string[] = [], titles: string[] = [];
  const answers: (string | number | undefined)[] = [], inputs: (string | undefined)[] = [], passwords: (string | undefined)[] = [];
  dialogs.password = async () => passwords.shift();
  const progress: string[] = [];
  let approve: boolean | undefined = true;
  const ctx = { mode: "tui", hasUI: true, ui: {
    select: async (title: string, choices: string[]) => {
      if (choices.length === 2 && choices.includes("Yes") && choices.includes("No")) {
        confirmations.push(title); return approve === undefined ? undefined : approve ? "Yes" : "No";
      }
      titles.push(title); menus.push([...choices]);
      assert.ok(answers.length, "Unexpected extra menu prompt");
      const answer = answers.shift();
      const selected = typeof answer === "number" ? choices[answer] : answer;
      assert.ok(selected === undefined || choices.includes(selected)); return selected;
    },
    input: async () => inputs.shift(),
    custom: async (factory: Function, options: { onHandle(handle: { setHidden(hidden: boolean): void }): void }) => new Promise(resolve => {
      const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, undefined, (result: unknown) => { component.dispose(); resolve(result); });
      progress.push(component.render(100).join("\n"));
      options.onHandle({ setHidden() {} });
    }),
    notify: (message: string, type: string) => { notifications.push({ message, type }); },
  } } as unknown as ExtensionContext;
  return { runtime, host, connections, menus, notifications, confirmations, titles, answers, inputs, passwords, progress,
    decline: () => { approve = false; },
    cancelConfirmation: () => { approve = undefined; },
    run: async () => { await hostMenu(ctx, runtime, dialogs, "session"); assert.deepEqual(notifications, [], "Management must not send global notifications"); },
    close: async () => { dialogs.close(); runtime.close(); await temp.close(); },
  };
}

test("SSH menus expose only host management actions without connecting", async t => {
  const f = await fixture(); t.after(f.close);
  f.answers.push(1, "Back", "Close");
  await f.run();
  assert.equal(f.menus[0].length, 3);
  assert.equal(f.menus[0][0], "Add host");
  assert.equal(f.menus[0][1], `Menu host | ~ [${f.host.id}]`);
  assert.equal(f.menus[0][2], "Close");
  assert.deepEqual(f.menus[1], ["Test connection", "Edit host", "Set login credential", "Delete host", "Back"]);
  assert.equal(f.titles[1], "Menu host | ~");
  assert.equal(f.connections.length, 0);
  assert.deepEqual(f.confirmations, []);
});

test("host menus omit live status while agent discovery retains connection and reconnect information", async t => {
  const f = await fixture(); t.after(f.close);
  await f.runtime.setWorkspace("session", f.host.id, "/srv/app");
  await f.runtime.save({ id: f.host.id, name: f.host.name, hostname: "changed.test", username: f.host.username, auth: f.host.auth });
  f.answers.push(1, "Back", "Close");
  await f.run();
  assert.equal(f.menus[0][1], `Menu host | /srv/app [${f.host.id}]`);
  assert.equal(f.titles[1], "Menu host | /srv/app");
  const listed = await executeTool("ssh_list_hosts", {}, { runtime: f.runtime, sessionId: "session", cwd: "/" });
  const hosts = listed.hosts as { id: string; status: string; sftp: boolean; changed: boolean }[];
  assert.equal(hosts[0].id, f.host.id);
  assert.equal(hosts[0].status, "connected");
  assert.equal(hosts[0].sftp, true);
  assert.equal(hosts[0].changed, true);
});

test("explicit connection tests show local progress and results and release their temporary connection", async t => {
  const f = await fixture(); t.after(f.close);
  f.answers.push(1, "Test connection", "Back", "Close");
  await f.run();
  assert.match(f.progress[0], /Testing Menu host: SSH and SFTP/);
  assert.ok(f.titles.some(title => title.startsWith("Connection test\nSSH: available | SFTP: available")));
  assert.equal(f.connections[0].alive, false);
  assert.equal(f.runtime.state("session").hosts[0].status, "disconnected");
});

for (const action of ["Add host", "Edit host"] as const) {
  test(`Escape during ${action} discards the draft without notifying`, async t => {
    const f = await fixture(); t.after(f.close);
    await f.runtime.profiles.load();
    const original = f.runtime.profiles.list();
    f.inputs.push("Uncommitted name", undefined);
    f.answers.push(...(action === "Add host" ? ["Add host", "Close"] : [1, "Edit host", "Close"]));
    await f.run();
    assert.deepEqual(f.runtime.profiles.list(), original);
  });
}

test("successful host edits return to the updated list without a success notification", async t => {
  const f = await fixture(); t.after(f.close);
  f.inputs.push("Renamed host", "menu.test", "22", "tester");
  f.answers.push(1, "Edit host", "Password", "None", "Close");
  await f.run();
  assert.equal(f.runtime.profiles.get(f.host.id).name, "Renamed host");
  assert.ok(f.menus.at(-1)!.includes(`Renamed host | ~ [${f.host.id}]`));
});

test("cancelling optional login setup preserves a newly saved host without storing a credential", async t => {
  const f = await fixture(); t.after(f.close);
  f.inputs.push("New host", "new.test", "22", "tester");
  f.passwords.push(undefined);
  f.answers.push("Add host", "Password", "None", "Close");
  await f.run();
  const host = f.runtime.profiles.list().find(host => host.name === "New host")!;
  assert.ok(host);
  assert.equal(host.credentialId, undefined);
});

test("Escape at remember confirmation preserves the previous login credential", async t => {
  const f = await fixture(); t.after(f.close);
  const host = await f.runtime.save({ id: f.host.id, name: f.host.name, hostname: f.host.hostname, username: f.host.username, auth: f.host.auth }, "previous-fixture", false);
  f.passwords.push("uncommitted-fixture");
  f.cancelConfirmation();
  f.answers.push(1, "Set login credential", "Close");
  await f.run();
  const saved = f.runtime.profiles.get(host.id);
  assert.equal(saved.credentialId, host.credentialId);
  assert.equal(await f.runtime.credentials.get(saved.credentialId, saved.remembered), "previous-fixture");
});

test("explicit No at remember confirmation still saves a memory-only credential", async t => {
  const f = await fixture(); t.after(f.close);
  f.passwords.push("memory-fixture"); f.decline();
  f.answers.push(1, "Set login credential", "Close");
  await f.run();
  const saved = f.runtime.profiles.get(f.host.id);
  assert.equal(saved.remembered, false);
  assert.equal(await f.runtime.credentials.get(saved.credentialId, saved.remembered), "memory-fixture");
});

test("confirmed host deletion closes the current connection without a separate Disconnect action", async t => {
  const f = await fixture(); t.after(f.close);
  await f.runtime.connection("session", f.host.id, false);
  f.answers.push(1, "Delete host", "Close");
  await f.run();
  assert.equal(f.confirmations.length, 1);
  assert.doesNotMatch(f.confirmations[0], /Disconnect it first/);
  assert.equal(f.connections[0].alive, false);
  assert.deepEqual(f.runtime.profiles.list(), []);
  assert.deepEqual(f.notifications.filter(n => n.type === "error"), []);
});

test("cancelled host deletion preserves its connection and profile", async t => {
  const f = await fixture(); t.after(f.close);
  await f.runtime.connection("session", f.host.id, false);
  f.decline(); f.answers.push(1, "Delete host", "Close");
  await f.run();
  assert.equal(f.connections[0].alive, true);
  assert.equal(f.runtime.profiles.list().length, 1);
});

test("host deletion does not interrupt another session or remove its active profile", async t => {
  const f = await fixture(); t.after(f.close);
  await f.runtime.connection("session", f.host.id, false);
  await f.runtime.connection("other-session", f.host.id, false);
  f.answers.push(1, "Delete host", "Back", "Close");
  await f.run();
  assert.equal(f.connections[0].alive, false);
  assert.equal(f.connections[1].alive, true);
  assert.equal(f.runtime.profiles.list().length, 1);
  assert.ok(f.titles.some(title => /Remote SSH — Error/.test(title) && /in use/i.test(title)));
});

test("changed hosts require an explicit reset tool call, without an authorization dialog", async t => {
  const f = await fixture(); t.after(f.close);
  await f.runtime.connection("session", f.host.id, false);
  await f.runtime.save({ id: f.host.id, name: f.host.name, hostname: "changed.test", username: f.host.username, auth: f.host.auth });
  const env = { runtime: f.runtime, sessionId: "session", cwd: "/" };
  await assert.rejects(executeTool("ssh_read_file", { hostId: f.host.id, path: "fixture.txt" }, env),
    error => error instanceof Error && /ssh_reset_connection/.test(error.message));
  assert.equal(f.connections[0].alive, true);
  const result = await executeTool("ssh_reset_connection", { hostId: f.host.id }, env);
  assert.equal(result.ok, true);
  assert.equal(f.connections[0].alive, false);
  assert.equal(f.connections[1].chain.at(-1)!.hostname, "changed.test");
});
