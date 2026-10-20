import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings, KeybindingsManager, visibleWidth, type TUI } from "@earendil-works/pi-tui";

/** Real host component plus the actually loaded extension callbacks; no model or network. */
export function renderSmoke(definitions: ToolDefinition[]) {
  initTheme("dark", false);
  const previousKeys = getKeybindings();
  const bind = (key: "ctrl+o" | "ctrl+y") => setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: key, description: "Expand output" } }));
  bind("ctrl+o");
  const ui = { requestRender() {} } as unknown as TUI;
  const rows: ToolExecutionComponent[] = [];
  const row = (name: string) => {
    const definition = definitions.find(tool => tool.name === name)!;
    assert.ok(definition?.renderCall && definition.renderResult, `${name} renderers missing`);
    const value = new ToolExecutionComponent(name, `fixture-${rows.length}`, { hostId: "remote-id", command: "printf test", timeoutMs: 45000, path: "/srv/file", stdin: "private-stdin" }, undefined, definition, ui, "/tmp");
    rows.push(value); return value;
  };
  const shown = (value: ToolExecutionComponent, width = 100) => stripVTControlCharacters(value.render(width).join("\n"));
  try {
    const shell = row("ssh_shell_exec");
    shell.markExecutionStarted();
    shell.updateResult({ content: [], details: { running: true }, isError: false }, true);
    assert.match(shown(shell), /Elapsed /);
    const output = Array.from({ length: 20 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n");
    shell.updateResult({ content: [], details: { hostName: "kali", displayOutput: output }, isError: false }, true);
    const pendingBackground = shell.render(100).join("\n").match(/\x1b\[48;[^m]+m/)?.[0];
    assert.doesNotMatch(shown(shell), /line-00|private-stdin/);
    assert.match(shown(shell), /ctrl\+o/i);
    assert.match(shown(shell), /line-19/);
    shell.setExpanded(true);
    assert.match(shown(shell), /line-00/);
    shell.setExpanded(false);
    bind("ctrl+y"); shell.invalidate(); assert.match(shown(shell), /ctrl\+y/i);
    const final = { content: [], details: { hostName: "kali", displayOutput: output, exitCode: 124, outcome: "exited" }, isError: true, durationMs: 40100 };
    shell.updateResult(final, false);
    assert.match(shown(shell), /SSH · kali/);
    assert.match(shown(shell), /\$ printf test/);
    assert.match(shown(shell), /timeout 45s/);
    assert.match(shown(shell), /Command exited with code 124/);
    assert.match(shown(shell), /Took 40\.1s/);
    const failedBackground = shell.render(100).join("\n").match(/\x1b\[48;[^m]+m/)?.[0];
    assert.ok(pendingBackground && failedBackground && pendingBackground !== failedBackground);
    const restored = row("ssh_shell_exec"); restored.updateResult(final, false);
    assert.match(shown(restored), /Took 40\.1s/);
    assert.match(shown(restored), /SSH · kali/);
    const legacy = row("ssh_shell_exec"); legacy.updateResult({ content: [{ type: "text", text: "legacy" }], details: { stdout: "legacy", exitCode: 0, outcome: "exited" }, isError: false }, false);
    assert.doesNotMatch(shown(legacy), /Took|Command exited with code 0/);
    legacy.updateResult({ content: [{ type: "text", text: "Invalid tool arguments" }], details: {}, isError: true }, false);
    assert.match(shown(legacy), /Invalid tool arguments/);
    assert.doesNotMatch(shown(legacy), /Took/);
    for (const width of [12, 40, 100]) for (const line of shell.render(width)) assert.ok(visibleWidth(line) <= width);
    const dark = shell.render(100).join("\n");
    initTheme("light", false); shell.invalidate();
    assert.notEqual(shell.render(100).join("\n"), dark);
    assert.match(shown(shell), /Took 40\.1s/);
    shell.updateResult({ content: [], details: { displayOutput: "before\n\x1b[2Junsafe\x1b]0;title\x07", outcome: "unknown", exitCode: null, cancelled: true, fullOutputPath: "/tmp/private/output.log", displayTruncated: true }, isError: true, durationMs: 1000 }, false);
    assert.match(shown(shell), /Remote outcome unknown/); assert.match(shown(shell), /Full output: \/tmp\/private\/output.log/);
    assert.doesNotMatch(shell.render(100).join("\n"), /\x1b\[2J|\x1b\]0;/);
    for (const definition of definitions) {
      const component = row(definition.name);
      component.updateResult({ content: [{ type: "text", text: "result" }], details: { ok: true, directory: "/srv", bytes: 42 }, isError: false, durationMs: 250 }, false);
      assert.match(shown(component), /Took 0\.3s/);
      const successBackground = component.render(100).join("\n").match(/\x1b\[48;[^m]+m/)?.[0];
      assert.ok(successBackground);
    }
    console.log("PASS: real Pi tool rendering, all ten timers, streaming/expanded previews, remapped expand key, theme states, unknown outcome, reload duration, narrow widths");
  } finally {
    for (const component of rows) component.updateResult({ content: [], isError: false, durationMs: 0 }, false);
    setKeybindings(previousKeys);
  }
}
