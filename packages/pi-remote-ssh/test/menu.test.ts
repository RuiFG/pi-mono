import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostProfile } from "../src/domain.ts";
import { Permissions } from "../src/permissions.ts";
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
  const permissions = new Permissions(), dialogs = new Dialogs();
  const menus: string[][] = [], notifications: { message: string; type: string }[] = [];
  const confirmations: string[] = [];
  const answers: (string | number)[] = [];
  let approve = true;
  const ctx = { mode: "tui", hasUI: true, ui: {
    select: async (_title: string, choices: string[]) => {
      menus.push([...choices]);
      const answer = answers.shift();
      assert.notEqual(answer, undefined, "Unexpected extra menu prompt");
      const selected = typeof answer === "number" ? choices[answer] : answer;
      assert.ok(selected && choices.includes(selected)); return selected;
    },
    confirm: async (_title: string, message: string) => { confirmations.push(message); return approve; },
    notify: (message: string, type: string) => { notifications.push({ message, type }); },
  } } as unknown as ExtensionContext;
  return { runtime, host, connections, permissions, menus, notifications, confirmations, answers,
    decline: () => { approve = false; },
    run: () => hostMenu(ctx, runtime, permissions, dialogs, "session"),
    close: async () => { dialogs.close(); runtime.close(); await temp.close(); },
  };
}

test("SSH menus expose only host management actions without granting permission or connecting", async t => {
  const f = await fixture(); t.after(f.close);
  f.answers.push(1, "Back", "Close");
  await f.run();
  assert.equal(f.menus[0].length, 3);
  assert.equal(f.menus[0][0], "Add host");
  assert.ok(f.menus[0][1].includes(f.host.id));
  assert.equal(f.menus[0][2], "Close");
  assert.deepEqual(f.menus[1], ["Test connection", "Edit host", "Set login credential", "Delete host", "Back"]);
  assert.equal(f.connections.length, 0);
  assert.equal(f.permissions.has("session", [f.host]), false);
  assert.deepEqual(f.confirmations, []);
});

test("confirmed host deletion closes the current connection without a separate Disconnect action", async t => {
  const f = await fixture(); t.after(f.close);
  await f.runtime.connection("session", f.host.id, false);
  await f.permissions.authorize("session", [f.host], async () => true);
  f.answers.push(1, "Delete host", "Close");
  await f.run();
  assert.equal(f.confirmations.length, 1);
  assert.doesNotMatch(f.confirmations[0], /Disconnect it first/);
  assert.equal(f.connections[0].alive, false);
  assert.deepEqual(f.runtime.profiles.list(), []);
  assert.equal(f.permissions.has("session", [f.host]), false);
  assert.deepEqual(f.notifications.filter(n => n.type === "error"), []);
});

test("cancelled host deletion preserves its connection, profile and authorization", async t => {
  const f = await fixture(); t.after(f.close);
  await f.runtime.connection("session", f.host.id, false);
  await f.permissions.authorize("session", [f.host], async () => true);
  f.decline(); f.answers.push(1, "Delete host", "Close");
  await f.run();
  assert.equal(f.connections[0].alive, true);
  assert.equal(f.runtime.profiles.list().length, 1);
  assert.equal(f.permissions.has("session", [f.host]), true);
});

test("host deletion does not interrupt another session or remove its active profile", async t => {
  const f = await fixture(); t.after(f.close);
  await f.runtime.connection("session", f.host.id, false);
  await f.runtime.connection("other-session", f.host.id, false);
  f.answers.push(1, "Delete host", "Close");
  await f.run();
  assert.equal(f.connections[0].alive, false);
  assert.equal(f.connections[1].alive, true);
  assert.equal(f.runtime.profiles.list().length, 1);
  assert.ok(f.notifications.some(n => n.type === "error" && /in use/i.test(n.message)));
});

test("changed hosts direct tools to the available reset tool, which still requires authorization", async t => {
  const f = await fixture(); t.after(f.close);
  await f.runtime.connection("session", f.host.id, false);
  await f.runtime.save({ id: f.host.id, name: f.host.name, hostname: "changed.test", username: f.host.username, auth: f.host.auth });
  const env = { runtime: f.runtime, permissions: f.permissions, sessionId: "session", cwd: "/", confirm: async () => false };
  await assert.rejects(executeTool("ssh_list_directory", { hostId: f.host.id }, env),
    error => error instanceof Error && /ssh_reset_connection/.test(error.message));
  await assert.rejects(executeTool("ssh_reset_connection", { hostId: f.host.id }, env), { code: "PERMISSION_DENIED" });
  assert.equal(f.connections[0].alive, true);
  const result = await executeTool("ssh_reset_connection", { hostId: f.host.id }, { ...env, confirm: async () => true });
  assert.equal(result.ok, true);
  assert.equal(f.connections[0].alive, false);
  assert.equal(f.connections[1].chain.at(-1)!.hostname, "changed.test");
});
