import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CommandOutput, type OutputSnapshot } from "../src/output.ts";
import { toolResult } from "../src/tools.ts";
import { temporary } from "./helpers.ts";

test("streaming snapshots are cumulative, throttled, immutable and UTF-8 safe", async () => {
  const snapshots: OutputSnapshot[] = [];
  const output = new CommandOutput(value => snapshots.push(value));
  const bytes = Buffer.from("字");
  output.push("stdout", Buffer.from("first\n"));
  output.push("stdout", bytes.subarray(0, 1));
  await delay(120);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].displayOutput, "first\n");
  output.push("stderr", Buffer.from("diagnostic\n"));
  output.push("stdout", bytes.subarray(1));
  const final = output.finish();
  assert.equal(final.displayOutput, "first\ndiagnostic\n字");
  assert.equal(snapshots[0].displayOutput, "first\n");
  const count = snapshots.length;
  output.push("stdout", Buffer.from("late")); output.finish();
  await delay(120);
  assert.equal(snapshots.length, count);
  assert.equal(final.displayTruncated, false);
});

test("overflow retains a bounded tail and a complete private log, with no log for small output", async t => {
  const temp = await temporary(); t.after(temp.close);
  const output = new CommandOutput(undefined, { maxBytes: 32, maxLines: 4, temporaryDirectory: temp.directory });
  output.push("stdout", Buffer.from("start\n"));
  assert.deepEqual(await readdir(temp.directory), []);
  const large = "字".repeat(500) + "\nend\n";
  output.push("stderr", Buffer.from(large));
  output.push("stdout", Buffer.from("last\n"));
  const final = output.finish();
  assert.equal(final.displayTruncated, true);
  assert.ok(Buffer.byteLength(final.displayOutput) <= 32);
  assert.ok(!final.displayOutput.includes("�"));
  assert.ok(final.displayOutput.endsWith("end\nlast\n"));
  assert.equal(await readFile(final.fullOutputPath!, "utf8"), "start\n" + large + "last\n");
  if (process.platform !== "win32") {
    assert.equal((await stat(final.fullOutputPath!)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(final.fullOutputPath!))).mode & 0o777, 0o700);
  }
  output.finish(); // Finalization must not delete a log referenced by a result.
  assert.ok((await stat(final.fullOutputPath!)).isFile());
});

test("JSON-escaping overflow also saves a complete copy before protocol truncation", async t => {
  const temp = await temporary(); t.after(temp.close);
  const output = new CommandOutput(undefined, { temporaryDirectory: temp.directory });
  const controls = "\u0000".repeat(10000);
  output.push("stdout", Buffer.from(controls));
  const final = output.finish();
  assert.equal(final.displayTruncated, true);
  assert.equal(await readFile(final.fullOutputPath!, "utf8"), controls);
  assert.ok(Buffer.byteLength(JSON.stringify(final.displayOutput)) <= 12 * 1024 + 2);
});

test("line-limit overflow saves the entire stream too", async t => {
  const temp = await temporary(); t.after(temp.close);
  const output = new CommandOutput(undefined, { maxBytes: 1024, maxLines: 3, temporaryDirectory: temp.directory });
  output.push("stdout", Buffer.from("1\n2\n3\n4\n5"));
  const final = output.finish();
  assert.equal(final.displayOutput, "3\n4\n5");
  assert.equal(await readFile(final.fullOutputPath!, "utf8"), "1\n2\n3\n4\n5");
});

test("log failures and broken UI callbacks do not discard the tail or change command outcomes", async t => {
  const temp = await temporary(); t.after(temp.close);
  const file = path.join(temp.directory, "not-a-directory"); await writeFile(file, "fixture");
  const output = new CommandOutput(() => { throw new Error("UI disconnected"); }, { maxBytes: 4, temporaryDirectory: file });
  output.push("stdout", Buffer.from("abcdefgh"));
  const final = output.finish();
  assert.equal(final.displayOutput, "efgh");
  assert.equal(final.fullOutputPath, undefined);
  assert.equal(Object.hasOwn(final, "fullOutputPath"), true, "Snapshots must explicitly clear stale advertised paths");
  assert.match(final.outputLogError!, /could not be saved/);
});

test("large escaped shell results keep stream fields, log retrieval, tail and outcome under 64 KiB", () => {
  const huge = "\u0000\"\\\n".repeat(60_000);
  const result = toolResult({ ok: false, stdout: huge, stderr: huge, displayOutput: huge + "FINAL", displayTruncated: true,
    fullOutputPath: "/tmp/private/output.log", outcome: "unknown", exitCode: null, cancelled: true });
  assert.equal(result.isError, true);
  assert.ok(Buffer.byteLength(result.content[0].text) < 64 * 1024);
  assert.equal(result.details.fullOutputPath, "/tmp/private/output.log");
  assert.equal(result.details.outcome, "unknown");
  assert.equal(result.details.exitCode, null);
  assert.equal(typeof result.details.stdout, "string");
  assert.equal(typeof result.details.stderr, "string");
  assert.ok(String(result.details.displayOutput).endsWith("FINAL"));
});
