import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import { Connection } from "../src/transport.ts";
import { CommandOutput } from "../src/output.ts";

function fixture() {
  const channel = new EventEmitter() as EventEmitter & { stderr: EventEmitter; end(value?: string): void; write(value: string): void; close(): void; signal(value: string): void };
  channel.stderr = new EventEmitter();
  const writes: string[] = [], signals: string[] = [];
  channel.end = value => { if (value) writes.push(value); };
  channel.write = value => { writes.push(value); };
  channel.close = () => { channel.emit("close"); };
  channel.signal = value => { signals.push(value); };
  const client = new EventEmitter() as EventEmitter & { exec(command: string, callback: (error: undefined, stream: ClientChannel) => void): void; destroy(): void };
  let command = "";
  client.exec = (value, callback) => { command = value; callback(undefined, channel as unknown as ClientChannel); };
  client.destroy = () => {};
  const connection = new Connection([], [client as unknown as Client]);
  return { channel, client, connection, writes, signals, command: () => command };
}

test("transport streams both channels before exit and preserves final separate fields", async () => {
  const f = fixture(), capture = new CommandOutput();
  const pending = f.connection.exec("fixture", { onOutput: capture.push.bind(capture) });
  f.channel.emit("data", Buffer.from("first\n"));
  f.channel.stderr.emit("data", Buffer.from("warning\n"));
  f.channel.emit("data", Buffer.from("last\n"));
  assert.equal(capture.snapshot().displayOutput, "first\nwarning\nlast\n");
  f.channel.emit("exit", 7); f.channel.emit("close");
  const result = await pending;
  assert.equal(result.stdout, "first\nlast\n"); assert.equal(result.stderr, "warning\n");
  assert.equal(result.exitCode, 7); assert.equal(result.outcome, "exited");
  capture.finish();
  f.channel.emit("data", Buffer.from("late"));
  assert.equal(capture.snapshot().displayOutput, "first\nwarning\nlast\n");
});

test("sudo streaming observes only filtered stderr and never authentication markers or credentials", async () => {
  const f = fixture(), capture = new CommandOutput();
  const pending = f.connection.exec("fixture", { sudo: async () => "private-fixture", stdin: "input-fixture", onOutput: capture.push.bind(capture) });
  const prompt = /remote-ssh-sudo-[\da-f-]+/.exec(f.command())![0];
  const ready = /remote-ssh-root-[\da-f-]+/.exec(f.command())![0];
  for (const byte of Buffer.from("notice\n" + prompt)) f.channel.stderr.emit("data", Buffer.from([byte]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.writes, ["private-fixture\n"]);
  for (const byte of Buffer.from(ready + "diagnostic\n")) f.channel.stderr.emit("data", Buffer.from([byte]));
  f.channel.emit("data", Buffer.from("result\n"));
  f.channel.emit("exit", 0); f.channel.emit("close");
  const result = await pending, final = capture.finish();
  assert.equal(result.elevated, true);
  assert.deepEqual(f.writes, ["private-fixture\n", "input-fixture"]);
  assert.equal(final.displayOutput, "notice\ndiagnostic\nresult\n");
  assert.doesNotMatch(JSON.stringify(final), /private-fixture|input-fixture|remote-ssh-/);
});

for (const mode of ["cancel", "disconnect", "timeout"] as const) {
  test(`streaming preserves partial output and unknown status on ${mode}`, async () => {
    const f = fixture(), capture = new CommandOutput(), controller = new AbortController();
    const pending = f.connection.exec("fixture", { signal: controller.signal, timeoutMs: mode === "timeout" ? 5 : 0, onOutput: capture.push.bind(capture) });
    f.channel.emit("data", Buffer.from("before\n"));
    if (mode === "cancel") controller.abort();
    else if (mode === "disconnect") f.client.emit("close");
    else await new Promise(resolve => setTimeout(resolve, 20));
    f.channel.emit("close");
    const result = await pending;
    assert.equal(result.exitCode, null); assert.equal(result.outcome, "unknown");
    assert.equal(result.cancelled, mode === "cancel"); assert.equal(result.timedOut, mode === "timeout");
    assert.equal(capture.finish().displayOutput, "before\n");
  });
}
