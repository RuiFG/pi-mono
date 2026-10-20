import { matchesKey, Key, truncateToWidth, CURSOR_MARKER, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { display } from "./permissions.ts";

/** Never gives the renderer the plaintext. Input stays outside the transcript. */
export class PasswordInput implements Component, Focusable {
  focused = true;
  private value = "";
  private paste = false;
  constructor(private title: string, private done: (value: string | undefined) => void, private renderAgain: () => void) {}
  invalidate() {}
  dispose() { this.value = ""; }
  handleInput(data: string) {
    if (data.includes("\x1b[200~")) { this.paste = true; data = data.replace("\x1b[200~", ""); }
    if (this.paste) {
      const end = data.indexOf("\x1b[201~");
      const text = end < 0 ? data : data.slice(0, end);
      this.value += text.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, Math.max(0, 4096 - this.value.length));
      if (end >= 0) this.paste = false;
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.value = ""; this.done(undefined); return;
    } else if (matchesKey(data, Key.enter)) {
      const value = this.value; this.value = ""; this.done(value); return;
    } else if (matchesKey(data, Key.backspace)) {
      const chars = Array.from(this.value); chars.pop(); this.value = chars.join("");
    } else if (matchesKey(data, Key.ctrl("u"))) {
      this.value = "";
    } else if (!data.includes("\x1b")) {
      this.value += data.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, Math.max(0, 4096 - this.value.length));
    }
    this.renderAgain();
  }
  render(width: number) {
    if (width <= 0) return [];
    const mask = "*".repeat(Math.min(Array.from(this.value).length, Math.max(0, width - 3)));
    return [truncateToWidth(display(this.title), width), truncateToWidth("> " + mask, Math.max(0, width - 1)) + CURSOR_MARKER + " ", truncateToWidth("Enter: confirm | Esc: cancel | Ctrl+U: clear", width)];
  }
}

export async function password(ctx: ExtensionContext, title: string, signal?: AbortSignal) {
  if (ctx.mode !== "tui" || signal?.aborted) return undefined;
  return ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
    let finished = false;
    const finish = (value: string | undefined) => { if (!finished) { finished = true; done(value); } };
    const input = new PasswordInput(title, finish, () => tui.requestRender());
    const abort = () => finish(undefined);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) queueMicrotask(abort);
    return {
      focused: true,
      render: (width: number) => input.render(width),
      handleInput: (data: string) => input.handleInput(data),
      invalidate: () => input.invalidate(),
      dispose: () => { signal?.removeEventListener("abort", abort); input.dispose(); },
    };
  });
}
