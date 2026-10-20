import { test } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { PasswordInput, password } from "../src/password.ts";

const secret = "fixture-secret-密码-🗝";
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replaceAll(CURSOR_MARKER, "");

test("SSH and sudo password cards are themed, masked and bounded across terminal widths", () => {
  const themed: string[] = [];
  const theme = {
    fg: (_token: string, text: string) => { themed.push(text); return `\x1b[36m${text}\x1b[39m`; },
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as Pick<Theme, "fg" | "bold">;
  for (const title of ["SSH password for Development", "Sudo password for 生产服务器", "Authentication failed. Retry: Sudo password for Production", "Private key passphrase for " + "Long host ".repeat(12)]) {
    const input = new PasswordInput(title, () => {}, () => {}, theme);
    input.handleInput(secret.repeat(40));
    assert.deepEqual(input.render(0), []);
    for (const width of [1, 2, 3, 10, 23, 24, 32, 40, 80, 120]) {
      const lines = input.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `Overflow at width ${width}`);
      assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
      assert.ok(!lines.join("").includes(secret));
      if (width >= 80) {
        const rendered = lines.map(plain).join("\n");
        assert.match(rendered, /SSH CREDENTIAL/);
        assert.match(rendered, /Kept out of chat and model context/);
        assert.match(rendered, /Ctrl\+U: clear/);
        assert.ok(rendered.startsWith("╭"));
      }
    }
    input.focused = false;
    assert.ok(!input.render(80).join("").includes(CURSOR_MARKER));
    input.dispose();
    assert.ok(!input.render(80).join("").includes("***"));
  }
  assert.ok(!themed.some(text => text.includes(secret)), "Theme callbacks must never receive the password");
});

test("password editing preserves masking across paste, clear, submit and cancellation", () => {
  const results: (string | undefined)[] = [];
  const input = new PasswordInput("Sudo password for Test", value => results.push(value), () => {});
  input.handleInput("\x1b[200~" + secret + "\n");
  input.handleInput("\x1b[201~");
  assert.equal(results.length, 0);
  input.handleInput("\x15");
  input.handleInput("replacement"); input.handleInput("\r");
  assert.deepEqual([...results], ["replacement"]);
  assert.ok(!input.render(80).join("").includes("***"));
  const cancelled = new PasswordInput("SSH password for Test", value => results.push(value), () => {});
  cancelled.handleInput(secret); cancelled.handleInput("\x1b");
  assert.deepEqual(results, ["replacement", undefined]);
  assert.ok(!cancelled.render(80).join("").includes("***"));
});

test("custom password UI forwards focus and cancels cleanly without submitting on abort", async () => {
  const controller = new AbortController();
  let completions = 0;
  const ctx = { mode: "tui", ui: { custom: async (factory: Function) => {
    return new Promise(resolve => {
      const component = factory({ requestRender() {} }, undefined, undefined, (value: unknown) => { completions++; resolve(value); });
      component.handleInput(secret);
      component.focused = false;
      assert.ok(!component.render(80).join("").includes(CURSOR_MARKER));
      component.focused = true;
      assert.ok(component.render(80).join("").includes(CURSOR_MARKER));
      controller.abort();
      component.dispose();
      assert.ok(!component.render(80).join("").includes("***"));
    });
  } } } as unknown as ExtensionContext;
  assert.equal(await password(ctx, "Sudo password for Test", controller.signal), undefined);
  assert.equal(completions, 1);
});
