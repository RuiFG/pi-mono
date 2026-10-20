import { matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi, renderFakeCursor, CURSOR_MARKER, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { display } from "./permissions.ts";

/** Never gives the renderer the plaintext. Input stays outside the transcript. */
export class PasswordInput implements Component, Focusable {
  focused = true;
  private value = "";
  private paste = false;
  private reuseSelected: boolean;
  constructor(private title: string, private done: (value: string | undefined) => void, private renderAgain: () => void, private theme?: Pick<Theme, "fg" | "bold"> & Partial<Pick<Theme, "bg">>, private reuseSSH?: () => void) {
    this.reuseSelected = !!reuseSSH;
  }
  invalidate() {}
  dispose() { this.value = ""; }
  handleInput(data: string) {
    if (this.reuseSSH && !this.paste) {
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
        this.reuseSelected = matchesKey(data, Key.tab) ? !this.reuseSelected : matchesKey(data, Key.up);
        this.renderAgain(); return;
      }
      if (this.reuseSelected) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.dispose(); this.done(undefined); }
        else if (matchesKey(data, Key.enter)) { this.dispose(); this.reuseSSH(); }
        // Typing on the reuse row never silently selects or submits a different credential.
        return;
      }
    }
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
    const color = (token: ThemeColor, text: string) => this.theme?.fg(token, text) ?? text;
    const bold = (text: string) => this.theme?.bold(text) ?? text;
    const cursor = this.focused && !this.reuseSelected ? CURSOR_MARKER + renderFakeCursor(" ") : " ";
    const length = Array.from(this.value).length;
    // Very narrow terminals still get a usable input and correctly positioned cursor.
    if (width < 24) {
      const prefix = width >= 3 ? "> " : "";
      const mask = "*".repeat(Math.min(length, Math.max(0, width - prefix.length - 1)));
      return [truncateToWidth(display(this.title), width),
        ...(this.reuseSSH ? [truncateToWidth(`${this.reuseSelected ? "›" : " "} Use SSH password`, width), truncateToWidth("Sudo password:", width)] : []),
        prefix + mask + cursor,
        truncateToWidth(this.reuseSSH ? "↑↓: select | Enter: confirm | Esc: cancel" : "Enter: confirm | Esc: cancel | Ctrl+U: clear", width)];
    }
    // Match rpiv-ask-user-question's single-question chrome and numbered inline row.
    // Only masked characters reach layout/theme helpers, never the credential buffer.
    const selected = (text: string) => color("accent", bold(text));
    const border = color("accent", "─".repeat(width));
    const header = this.title.includes("Sudo password") ? "Sudo" : "SSH";
    const badge = ` ${header} `;
    const inputActive = this.focused && !this.reuseSelected;
    const prefix = `${inputActive ? "❯ " : "  "}${this.reuseSSH ? "2" : "1"}. `;
    const available = width - visibleWidth(prefix) - 1;
    const mask = "*".repeat(Math.min(length, available));
    const input = inputActive
      ? selected(prefix + mask + cursor)
      : prefix + (mask || "Type something.");
    const reuseActive = this.focused && this.reuseSelected;
    const reuse = `${reuseActive ? "❯" : " "} 1. Use SSH password`;
    const hints = ["Enter to confirm", ...(this.reuseSSH ? ["↑/↓ to navigate"] : []), "Esc to cancel", ...(!this.reuseSelected ? ["Ctrl+U to clear"] : [])].join(" · ");
    return [
      border, "",
      " " + (this.theme?.bg?.("selectedBg", badge) ?? badge), "",
      ...wrapTextWithAnsi(bold(display(this.title)), width - 2).map(line => " " + line), "",
      ...(this.reuseSSH ? [reuseActive ? selected(reuse) : reuse,
        ...wrapTextWithAnsi("Use this host's SSH login password for sudo.", width - 5).map(line => "     " + color("muted", line))] : []),
      input, "", border, "",
      color("dim", truncateToWidth(" " + hints, width)),
    ];
  }
}

export type SudoPasswordAnswer = { reuseSSH: true } | { reuseSSH: false; value: string };

export async function password(ctx: ExtensionContext, title: string, signal?: AbortSignal) {
  const answer = await credentialPrompt(ctx, title, false, signal);
  return answer && !answer.reuseSSH ? answer.value : undefined;
}

export function sudoPassword(ctx: ExtensionContext, title: string, signal?: AbortSignal) {
  return credentialPrompt(ctx, title, true, signal);
}

async function credentialPrompt(ctx: ExtensionContext, title: string, allowReuse: boolean, signal?: AbortSignal) {
  if (ctx.mode !== "tui" || signal?.aborted) return undefined;
  return ctx.ui.custom<SudoPasswordAnswer | undefined>((tui, theme, _keys, done) => {
    let finished = false;
    const finish = (value: SudoPasswordAnswer | undefined) => { if (!finished) { finished = true; done(value); } };
    const input = new PasswordInput(title, value => finish(value === undefined ? undefined : { reuseSSH: false, value }), () => tui.requestRender(), theme,
      allowReuse ? () => finish({ reuseSSH: true }) : undefined);
    const abort = () => finish(undefined);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) queueMicrotask(abort);
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width: number) => input.render(width),
      handleInput: (data: string) => input.handleInput(data),
      invalidate: () => input.invalidate(),
      dispose: () => { signal?.removeEventListener("abort", abort); input.dispose(); },
    };
  });
}
