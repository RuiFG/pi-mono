import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Serial, SshError, errorText, checkAbort, type HostDraft, type HostProfile } from "./domain.ts";
import { RemoteRuntime, type CredentialRequest } from "./runtime.ts";
import { Permissions, display, type Confirm } from "./permissions.ts";
import { localPath } from "./paths.ts";
import { password, sudoPassword } from "./password.ts";

/** One queue for dialogs only; never hold it while waiting on an SSH operation. */
export class Dialogs {
  private serial = new Serial();
  private lifetime = new AbortController();
  close() { this.lifetime.abort(); }
  signal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal; }
  async run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = this.signal(signal);
    return this.serial.run(async () => { checkAbort(combined); const result = await operation(combined); checkAbort(combined); return result; });
  }
  confirm(ctx: ExtensionContext): Confirm {
    return (title, message, signal) => this.run(combined => ctx.hasUI ? ctx.ui.confirm(title, message, { signal: combined }) : Promise.resolve(false), signal);
  }
  select(ctx: ExtensionContext, title: string, choices: string[], signal?: AbortSignal) {
    return this.run(combined => ctx.ui.select(title, choices, { signal: combined }), signal);
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
    else throw new SshError("CREDENTIAL_CANCELLED", "Credential was not saved");
  }
}

export async function hostMenu(ctx: ExtensionContext, runtime: RemoteRuntime, permissions: Permissions, dialogs: Dialogs, sessionId: string) {
  if (ctx.mode !== "tui") throw new SshError("UI_REQUIRED", "/ssh requires the interactive Pi terminal UI");
  while (true) {
    await runtime.profiles.load();
    const states = runtime.state(sessionId).hosts;
    const labels = states.map(({ host, status, directory, changed }) => `${display(host.name)} | ${status}${changed ? " (reconnect required)" : ""} | ${display(directory ?? "~")} [${host.id}]`);
    const selected = await dialogs.select(ctx, "Remote SSH", ["Add host", ...labels, "Close"]);
    if (!selected || selected === "Close") return;
    try {
      if (selected === "Add host") {
        const draft = await draftHost(ctx, dialogs, runtime);
        if (draft) {
          const host = await runtime.save(draft);
          if (await dialogs.confirm(ctx)("Set login credential now?", "Otherwise it will be requested when connecting. Unencrypted private keys need no passphrase.")) await setLoginCredential(ctx, dialogs, runtime, host);
          ctx.ui.notify("Host saved", "info");
        }
        continue;
      }
      const { host, status, directory, changed, sftp, error } = states[labels.indexOf(selected)];
      const action = await dialogs.select(ctx, `${display(host.name)} | ${status} | SFTP: ${sftp === undefined ? "not tested" : sftp ? "available" : "unavailable"}${changed ? " | reconnect required" : ""}${directory ? ` | ${display(directory)}` : ""}${error ? ` | ${display(error)}` : ""}`, ["Test connection", "Edit host", "Set login credential", "Delete host", "Back"]);
      switch (action) {
        case "Test connection": {
          ctx.ui.notify("Testing SSH and SFTP...", "info");
          const result = await runtime.test(host.id, dialogs.signal());
          ctx.ui.notify(`SSH: available | SFTP: ${result.sftp ? "available" : "unavailable"} | Home: ${display(result.home)}`, result.sftp ? "info" : "warning"); break;
        }
        case "Edit host": {
          const draft = await draftHost(ctx, dialogs, runtime, host);
          if (draft) { await runtime.save(draft); permissions.revoke(sessionId); ctx.ui.notify("Host saved. Use ssh_reset_connection to apply changes to an existing connection.", "info"); }
          break;
        }
        case "Set login credential": await setLoginCredential(ctx, dialogs, runtime, host); break;
        case "Delete host":
          if (await dialogs.confirm(ctx)("Delete host?", `Remove ${display(host.name)} and its stored credentials? Its connection in this session will be closed. Deletion is blocked if another connection still uses this host.`)) {
            await runtime.disconnect(sessionId, host.id);
            await runtime.deleteHost(host.id); permissions.clear();
          }
          break;
      }
    } catch (error) { ctx.ui.notify(display(errorText(error)), "error"); }
  }
}
