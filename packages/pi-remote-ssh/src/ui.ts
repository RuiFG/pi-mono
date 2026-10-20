import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, Text, type OverlayHandle } from "@earendil-works/pi-tui";
import { Serial, SshError, errorText, checkAbort, type HostDraft, type HostProfile } from "./domain.ts";
import { RemoteRuntime, type CredentialRequest } from "./runtime.ts";
import { display, type Confirm } from "./permissions.ts";
import { localPath } from "./paths.ts";
import { password, sudoPassword } from "./password.ts";

function isCancellation(error: unknown) {
  return error instanceof SshError && ["CANCELLED", "CREDENTIAL_CANCELLED"].includes(error.code)
    || error instanceof Error && error.name === "AbortError";
}

/** One queue for dialogs only; never hold it while waiting on an SSH operation. */
export class Dialogs {
  private serial = new Serial();
  private lifetime = new AbortController();
  private activeDialogs = 0;
  private progressOverlays = new Set<OverlayHandle>();
  close() { this.lifetime.abort(); }
  signal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal; }
  async run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = this.signal(signal);
    this.activeDialogs++;
    for (const overlay of this.progressOverlays) overlay.setHidden(true);
    try {
      return await this.serial.run(async () => { checkAbort(combined); const result = await operation(combined); checkAbort(combined); return result; });
    } finally {
      if (--this.activeDialogs === 0) for (const overlay of this.progressOverlays) overlay.setHidden(false);
    }
  }
  confirm(ctx: ExtensionContext): Confirm {
    return (title, message, signal) => this.run(async combined => {
      if (!ctx.hasUI) return false;
      // A boolean confirm conflates Escape with No. Only an explicit No may
      // continue with memory-only credentials; Escape must cancel the step.
      const answer = await ctx.ui.select(`${title}\n${message}`, ["No", "Yes"], { signal: combined });
      if (answer === undefined) throw new SshError("CANCELLED", "Operation cancelled");
      return answer === "Yes";
    }, signal);
  }
  select(ctx: ExtensionContext, title: string, choices: string[], signal?: AbortSignal) {
    return this.run(combined => ctx.ui.select(title, choices, { signal: combined }), signal);
  }
  async feedback(ctx: ExtensionContext, title: string, message: string) {
    await this.select(ctx, `${title}\n${display(message)}`, ["Back"]);
  }
  async error(ctx: ExtensionContext, error: unknown) {
    if (this.lifetime.signal.aborted || isCancellation(error)) return;
    await this.feedback(ctx, "Remote SSH — Error", errorText(error));
  }
  async progress<T>(ctx: ExtensionContext, title: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    checkAbort(this.lifetime.signal);
    let handle: OverlayHandle | undefined;
    type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
    try {
      // Never hold the dialog queue while connecting: authentication needs it.
      const result = await ctx.ui.custom<Outcome>((tui, theme, _keys, done) => {
        const loader = new CancellableLoader(tui, text => theme.fg("accent", text), text => theme.fg("muted", text), display(title));
        const hint = new Text("Esc to cancel", 1, 0);
        const controller = new AbortController();
        const signal = AbortSignal.any([this.lifetime.signal, loader.signal, controller.signal]);
        const finish = (outcome: Outcome) => { loader.dispose(); done(outcome); };
        void Promise.resolve().then(() => { checkAbort(signal); return operation(signal); }).then(
          value => { checkAbort(signal); return value; },
        ).then(value => finish({ ok: true, value }), error => finish({ ok: false, error }));
        return {
          render: (width: number) => width <= 0 ? [] : [theme.fg("accent", "─".repeat(width)), ...loader.render(width), ...hint.render(width), theme.fg("accent", "─".repeat(width))],
          handleInput: (data: string) => loader.handleInput(data),
          invalidate: () => loader.invalidate(),
          dispose: () => { controller.abort(); loader.dispose(); },
        };
      }, {
        overlay: true,
        overlayOptions: { anchor: "bottom-center", width: "100%" },
        onHandle: overlay => {
          handle = overlay; this.progressOverlays.add(overlay);
          overlay.setHidden(this.activeDialogs > 0);
        },
      });
      if (!result.ok) throw result.error;
      return result.value;
    } finally {
      if (handle) this.progressOverlays.delete(handle);
    }
  }
  input(ctx: ExtensionContext, title: string, previous?: string) {
    return this.run(signal => ctx.ui.input(previous ? `${title} (Enter to keep: ${display(previous)})` : title, previous, { signal }));
  }
  password(ctx: ExtensionContext, title: string, signal?: AbortSignal) {
    return this.run(combined => password(ctx, title, combined), signal);
  }
  sudoPassword(ctx: ExtensionContext, title: string, signal?: AbortSignal) {
    return this.run(combined => sudoPassword(ctx, title, combined), signal);
  }
}

export class CredentialDialogs {
  private pending = new Map<string, AbortController>();
  private unsubscribe: () => void;
  constructor(private runtime: RemoteRuntime, private dialogs: Dialogs, private context: () => ExtensionContext | undefined) {
    this.unsubscribe = runtime.onChange(() => this.pump());
  }
  private pump() {
    const requests = this.runtime.state().requests;
    for (const [id, controller] of this.pending) if (!requests.some(r => r.id === id)) { controller.abort(); this.pending.delete(id); }
    for (const request of requests) {
      if (this.pending.has(request.id)) continue;
      const controller = new AbortController();
      this.pending.set(request.id, controller);
      void this.answer(request, controller.signal).catch(() => {
        // Credential failures are reported to the operation, never as secret-bearing exceptions.
        void this.runtime.replyCredential(request.id).catch(() => {});
      }).finally(() => { controller.abort(); this.pending.delete(request.id); });
    }
  }
  private async answer(request: CredentialRequest, signal: AbortSignal) {
    const ctx = this.context();
    if (!ctx || ctx.mode !== "tui") { await this.runtime.replyCredential(request.id); return; }
    if (request.temporaryOnly && !await this.dialogs.confirm(ctx)("Use a temporary sudo credential?", "The remembered sudo credential could not be read or removed. Enter a replacement for this runtime only? The old stored credential reference will be kept, and the temporary replacement will be discarded when this runtime ends.", signal)) {
      await this.runtime.replyCredential(request.id); return;
    }
    const title = `${request.retry ? "Authentication failed. Retry: " : ""}${request.kind === "sudo" ? "Sudo password" : request.kind === "passphrase" ? "Private key passphrase" : "SSH password"} for ${display(request.hostName)}`;
    let reuse = false, value: string | undefined;
    if (request.canReuseSSH) {
      const answer = await this.dialogs.sudoPassword(ctx, title, signal);
      if (!answer) { await this.runtime.replyCredential(request.id); return; }
      reuse = answer.reuseSSH;
      value = answer.reuseSSH ? undefined : answer.value;
    } else value = await this.dialogs.password(ctx, title, signal);
    if (value === undefined && !reuse) { await this.runtime.replyCredential(request.id); return; }
    const remember = !request.temporaryOnly && await this.dialogs.confirm(ctx)("Remember credential?", "Save to an encrypted file on this computer? The key is stored locally; anyone with both files can decrypt it. Choose No to keep the credential only until this extension runtime ends.", signal);
    checkAbort(signal);
    try { await this.runtime.replyCredential(request.id, value, remember, reuse); }
    catch (error) {
      if (!(error instanceof SshError) || error.code !== "VAULT_UNAVAILABLE") throw error;
      if (await this.dialogs.confirm(ctx)("Credential store unavailable", "The credential could not be saved. Use it only for this runtime instead?", signal)) {
        await this.runtime.replyCredential(request.id, value, false, reuse);
      } else await this.runtime.replyCredential(request.id);
    }
  }
  close() { this.unsubscribe(); for (const controller of this.pending.values()) controller.abort(); this.pending.clear(); }
}

async function draftHost(ctx: ExtensionContext, dialogs: Dialogs, runtime: RemoteRuntime, old?: HostProfile): Promise<HostDraft | undefined> {
  const field = async (title: string, previous?: string) => {
    const value = await dialogs.input(ctx, title, previous);
    if (value === undefined) throw new SshError("CANCELLED", "Host editing cancelled");
    return value === "" && previous !== undefined ? previous : value;
  };
  const name = await field("Host name", old?.name);
  const hostname = await field("Hostname or IP address", old?.hostname);
  const port = Number(await field("SSH port", String(old?.port ?? 22)));
  const username = await field("SSH username", old?.username);
  const authChoice = await dialogs.select(ctx, "Authentication", ["Password", "Private key"]);
  if (!authChoice) return;
  const auth = authChoice === "Password" ? "password" : "key";
  const privateKeyPath = auth === "key" ? localPath(await field("Private key path", old?.privateKeyPath), ctx.cwd) : undefined;
  const candidates = runtime.profiles.list().filter(host => host.id !== old?.id);
  const labels = candidates.map(host => `${display(host.name)} [${host.id}]`);
  const jump = await dialogs.select(ctx, "Jump host (each jump can have its own jump host)", ["None", ...labels]);
  if (!jump) return;
  return { id: old?.id, name, hostname, port, username, auth, privateKeyPath, jumpHostId: jump === "None" ? undefined : candidates[labels.indexOf(jump)].id };
}

async function setLoginCredential(ctx: ExtensionContext, dialogs: Dialogs, runtime: RemoteRuntime, host: HostProfile) {
  const value = await dialogs.password(ctx, `${host.auth === "password" ? "SSH password" : "Private key passphrase"} for ${display(host.name)}`);
  if (value === undefined) return;
  const remember = await dialogs.confirm(ctx)("Remember credential?", "Save to an encrypted file on this computer? The key is stored locally; anyone with both files can decrypt it. Choose No for memory-only storage.");
  const { revision: _revision, credentialId: _credential, remembered: _remembered, ...draft } = host;
  try { await runtime.save(draft, value, remember); }
  catch (error) {
    if (!(error instanceof SshError) || error.code !== "VAULT_UNAVAILABLE" || !remember) throw error;
    if (await dialogs.confirm(ctx)("Credential store unavailable", "Use the credential for this runtime only instead?")) await runtime.save(draft, value, false);
  }
}

export async function hostMenu(ctx: ExtensionContext, runtime: RemoteRuntime, dialogs: Dialogs, sessionId: string) {
  if (ctx.mode !== "tui") throw new SshError("UI_REQUIRED", "/ssh requires the interactive Pi terminal UI");
  while (true) {
    await runtime.profiles.load();
    const states = runtime.state(sessionId).hosts;
    const labels = states.map(({ host, directory }) => `${display(host.name)} | ${display(directory ?? "~")} [${host.id}]`);
    const selected = await dialogs.select(ctx, "Remote SSH", ["Add host", ...labels, "Close"]);
    if (!selected || selected === "Close") return;
    try {
      if (selected === "Add host") {
        const draft = await draftHost(ctx, dialogs, runtime);
        if (draft) {
          const host = await runtime.save(draft);
          if (await dialogs.confirm(ctx)("Set login credential now?", "Otherwise it will be requested when connecting. Unencrypted private keys need no passphrase.")) await setLoginCredential(ctx, dialogs, runtime, host);
        }
        continue;
      }
      const { host, directory } = states[labels.indexOf(selected)];
      const action = await dialogs.select(ctx, `${display(host.name)} | ${display(directory ?? "~")}`, ["Test connection", "Edit host", "Set login credential", "Delete host", "Back"]);
      switch (action) {
        case "Test connection": {
          const result = await dialogs.progress(ctx, `Testing ${display(host.name)}: SSH and SFTP...`, signal => runtime.test(host.id, signal));
          await dialogs.feedback(ctx, "Connection test", `SSH: available | SFTP: ${result.sftp ? "available" : "unavailable"} | Home: ${display(result.home)}`); break;
        }
        case "Edit host": {
          const draft = await draftHost(ctx, dialogs, runtime, host);
          if (draft) await runtime.save(draft);
          break;
        }
        case "Set login credential": await setLoginCredential(ctx, dialogs, runtime, host); break;
        case "Delete host":
          if (await dialogs.confirm(ctx)("Delete host?", `Remove ${display(host.name)} and its stored credentials? Its connection in this session will be closed. Deletion is blocked if another connection still uses this host.`)) {
            await runtime.disconnect(sessionId, host.id);
            await runtime.deleteHost(host.id);
          }
          break;
      }
    } catch (error) { await dialogs.error(ctx, error); }
  }
}
