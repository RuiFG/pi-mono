import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Dialogs } from "../src/ui.ts";
import { SshError } from "../src/domain.ts";

function fixture() {
  const dialogs = new Dialogs();
  const hidden: boolean[] = [], rendered: string[] = [];
  let component: { handleInput(data: string): void; dispose(): void } | undefined;
  let disposed = false;
  const ctx = { mode: "tui", hasUI: true, ui: {
    custom: async (factory: Function, options: { overlay: boolean; onHandle(handle: { setHidden(value: boolean): void }): void }) => new Promise(resolve => {
      assert.equal(options.overlay, true);
      const view = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, undefined, (value: unknown) => {
        disposed = true; view.dispose(); resolve(value);
      });
      component = view;
      rendered.push(view.render(40).join("\n"));
      options.onHandle({ setHidden(value) { hidden.push(value); } });
    }),
    select: async () => "No",
    notify: () => { throw new Error("Unexpected global notification"); },
  } } as unknown as ExtensionContext;
  return { dialogs, ctx, hidden, rendered, cancel: () => component!.handleInput("\x1b"), disposed: () => disposed };
}

test("connection progress yields to credential dialogs without locking their queue", async t => {
  const f = fixture(); t.after(() => f.dialogs.close());
  const result = await f.dialogs.progress(f.ctx, "Testing SSH...", async () => {
    assert.equal(await f.dialogs.confirm(f.ctx)("Remember credential?", "Fixture"), false);
    return "connected";
  });
  assert.equal(result, "connected");
  assert.deepEqual(f.hidden, [false, true, false]);
  assert.match(f.rendered[0], /Testing SSH/);
  assert.equal(f.disposed(), true);
});

for (const cancel of ["escape", "shutdown"] as const) {
  test(`connection progress ${cancel} aborts work, disposes the screen, and remains silent`, async t => {
    const f = fixture(); t.after(() => f.dialogs.close());
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const result = f.dialogs.progress(f.ctx, "Testing SSH...", signal => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new SshError("CANCELLED", "Operation cancelled")), { once: true });
      started();
    }));
    const rejected = assert.rejects(result, { code: "CANCELLED" });
    await ready;
    if (cancel === "escape") f.cancel(); else f.dialogs.close();
    await rejected;
    assert.equal(f.disposed(), true);
    await f.dialogs.error(f.ctx, new SshError("CANCELLED", "Operation cancelled"));
  });
}

test("connection progress propagates failures and still releases its screen", async t => {
  const f = fixture(); t.after(() => f.dialogs.close());
  await assert.rejects(f.dialogs.progress(f.ctx, "Testing SSH...", async () => { throw new Error("Connection refused"); }), /Connection refused/);
  assert.equal(f.disposed(), true);
});

test("Escape at credential storage confirmation is distinct from an explicit No", async t => {
  const f = fixture(); t.after(() => f.dialogs.close());
  assert.equal(await f.dialogs.confirm(f.ctx)("Remember credential?", "Fixture"), false);
  f.ctx.ui.select = async () => undefined;
  await assert.rejects(f.dialogs.confirm(f.ctx)("Remember credential?", "Fixture"), { code: "CANCELLED" });
});

test("cancelled authentication is silent but genuine failures stay in a dismissible menu", async t => {
  const f = fixture(); t.after(() => f.dialogs.close());
  const titles: string[] = [];
  f.ctx.ui.select = async (title, choices) => { titles.push(title); assert.deepEqual(choices, ["Back"]); return undefined; };
  await f.dialogs.error(f.ctx, new SshError("CREDENTIAL_CANCELLED", "Credential was not provided"));
  await f.dialogs.error(f.ctx, new DOMException("Aborted", "AbortError"));
  assert.deepEqual(titles, []);
  await f.dialogs.error(f.ctx, new Error("Connection refused\x1b[31m"));
  assert.deepEqual(titles, ["Remote SSH — Error\nConnection refused"]);
});
