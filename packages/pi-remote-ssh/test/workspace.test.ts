import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteRuntime } from "../src/runtime.ts";
import type { Connector, Connection } from "../src/transport.ts";
import type { HostProfile } from "../src/domain.ts";
import { MemoryVault, temporary } from "./helpers.ts";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

test("directory updates stay serialized per host without blocking other hosts or leaking between sessions", { timeout: 3000 }, async t => {
  const temp = await temporary(); t.after(temp.close);
  const started = gate(), release = gate(); t.after(release.open);
  const calls: { hostId: string; directory: string }[] = [];
  const connector = { connect: async (chain: HostProfile[]) => ({
    chain, alive: true, home: "/home/tester", sftpAvailable: true,
    directory: async (directory: string) => {
      calls.push({ hostId: chain.at(-1)!.id, directory });
      if (directory === "/slow") { started.open(); await release.promise; }
      return directory;
    },
    onClose() {}, close() {},
  }) as unknown as Connection } as unknown as Connector;
  const runtime = new RemoteRuntime(temp.directory, new MemoryVault(), connector);
  await runtime.load(); t.after(() => runtime.close());
  const a = await runtime.save({ name: "A", hostname: "a.test", username: "tester", auth: "password" });
  const b = await runtime.save({ name: "B", hostname: "b.test", username: "tester", auth: "password" });
  const first = runtime.setWorkspace("session", a.id, "/slow");
  await started.promise;
  const second = runtime.setWorkspace("session", a.id, "/later");
  await runtime.setWorkspace("session", b.id, "/independent");
  assert.deepEqual(calls.filter(call => call.hostId === a.id).map(call => call.directory), ["/slow"]);
  release.open(); await Promise.all([first, second]);
  assert.equal(runtime.resolve("session", a.id).directory, "/later");
  assert.equal(runtime.resolve("session", b.id).directory, "/independent");
  await runtime.setWorkspace("other-session", a.id, undefined);
  assert.equal(runtime.resolve("other-session", a.id).directory, "/home/tester");
  await runtime.disconnect("session", a.id);
  assert.equal(runtime.resolve("session", a.id).directory, undefined);
  assert.equal(runtime.resolve("other-session", a.id).directory, "/home/tester");
  assert.equal(runtime.resolve("session", b.id).directory, "/independent");
});
