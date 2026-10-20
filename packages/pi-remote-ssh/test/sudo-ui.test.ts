import { test } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PasswordInput } from "../src/password.ts";
import { CredentialDialogs, Dialogs } from "../src/ui.ts";
import { RemoteRuntime } from "../src/runtime.ts";
import type { Connection, ExecOptions } from "../src/transport.ts";
import { MemoryVault, temporary } from "./helpers.ts";

const secret = "inline-fixture-秘密";

test("sudo choice focuses the editable second row directly, preserves input on navigation, and never renders plaintext", () => {
  const values: (string | undefined)[] = [];
  let reused = 0;
  const input = new PasswordInput("Sudo password for Test", value => values.push(value), () => {}, undefined, () => reused++);
  assert.match(input.render(80).join("\n"), /Use SSH password/);
  assert.ok(!input.render(80).join("").includes(CURSOR_MARKER));
  input.handleInput("\x1b[B"); // Down, no intermediate select/Enter needed.
  input.handleInput("\x1b[200~" + secret + "\x1b[201~");
  for (const width of [1, 2, 3, 12, 23, 24, 40, 80, 120]) {
    const lines = input.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(!lines.join("").includes(secret));
    assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
  }
  input.handleInput("\x1b[A");
  assert.ok(!input.render(80).join("").includes(CURSOR_MARKER));
  input.handleInput("\x1b[B"); input.handleInput("\r");
  assert.deepEqual(values, [secret]); assert.equal(reused, 0);
  assert.ok(!input.render(80).join("").includes("***"));
});

test("sudo dialog matches the upstream single-question numbered layout", () => {
  const input = new PasswordInput("Sudo password for Test", () => {}, () => {}, undefined, () => {});
  const border = "─".repeat(80);
  assert.deepEqual(input.render(80), [
    border, "", "  Sudo ", "", " Sudo password for Test", "",
    "❯ 1. Use SSH password",
    "     Use this host's SSH login password for sudo.",
    "  2. Type something.", "", border, "",
    " Enter to confirm · ↑/↓ to navigate · Esc to cancel",
  ]);
  input.handleInput("\x1b[B");
  input.handleInput("fixture");
  const lines = input.render(80);
  assert.equal(lines[6], "  1. Use SSH password");
  assert.ok(lines[8].startsWith("❯ 2. *******"));
  assert.ok(lines[8].includes(CURSOR_MARKER));
  assert.ok(!lines.join("\n").includes("Type something."));
  assert.ok(!lines.join("\n").includes("fixture"));
  assert.ok(!/[╭╮╰╯│]/.test(lines.join("\n")));
});

test("choosing SSH reuse or cancelling clears the inline password without returning it", () => {
  for (const cancel of [false, true]) {
    let reused = 0;
    const values: (string | undefined)[] = [];
    const input = new PasswordInput("Sudo password", value => values.push(value), () => {}, undefined, () => reused++);
    input.handleInput("\x1b[B"); input.handleInput(secret); input.handleInput("\x1b[A");
    input.handleInput(cancel ? "\x1b" : "\r");
    assert.equal(reused, cancel ? 0 : 1);
    assert.deepEqual(values, cancel ? [undefined] : []);
    assert.ok(!input.render(80).join("").includes("***"));
  }
});

for (const mode of ["reuse", "inline", "key", "retry", "cancel"] as const) {
  test(`sudo ${mode} follows the real credential dialog path without an intermediate selection dialog`, async t => {
    const temp = await temporary(); t.after(temp.close);
    const runtime = new RemoteRuntime(temp.directory, new MemoryVault()); await runtime.load(); t.after(() => runtime.close());
    const host = await runtime.save({ name: "Test", hostname: "example.test", username: "tester", auth: mode === "key" ? "key" : "password", ...(mode === "key" ? { privateKeyPath: "/fixture/key" } : {}) }, "ssh-fixture", false);
    const dialogs = new Dialogs(); t.after(() => dialogs.close());
    let screens = 0, commands = 0;
    const ctx = { mode: "tui", hasUI: true, ui: {
      select: async () => { throw new Error("Must not open an intermediate selection dialog"); },
      confirm: async () => false,
      custom: async (factory: Function) => new Promise(resolve => {
        screens++;
        const component = factory({ requestRender() {} }, undefined, undefined, resolve);
        const rendered = component.render(80).join("\n");
        assert.equal(rendered.includes("Use SSH password"), mode !== "key" && mode !== "retry");
        if (mode === "inline") component.handleInput("\x1b[B");
        if (mode === "inline" || mode === "key" || mode === "retry") component.handleInput(secret);
        assert.ok(!component.render(80).join("").includes(secret));
        component.handleInput(mode === "cancel" ? "\x1b" : "\r");
        component.dispose();
      }),
    } } as unknown as ExtensionContext;
    const bridge = new CredentialDialogs(runtime, dialogs, () => ctx); t.after(() => bridge.close());
    let received: string | undefined;
    const connection = { chain: [host], exec: async (_command: string, options: ExecOptions) => {
      commands++;
      received = await options.sudo!(new AbortController().signal, mode === "retry");
      return { elevated: true, exitCode: 0, outcome: "exited" };
    } } as unknown as Connection;
    const result = runtime.execSudo("session", connection, "id -u", {});
    if (mode === "cancel") await assert.rejects(result, { code: "CREDENTIAL_CANCELLED" });
    else {
      await result;
      assert.equal(received, mode === "reuse" ? "ssh-fixture" : secret);
    }
    assert.equal(screens, 1); assert.equal(commands, 1);
    assert.equal(runtime.state().requests.length, 0);
    assert.ok(!JSON.stringify(runtime.state()).includes(secret));
  });
}
