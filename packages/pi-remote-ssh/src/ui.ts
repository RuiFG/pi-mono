import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Serial, SshError, errorText, checkAbort, type HostDraft, type HostProfile } from "./domain.ts";
import { RemoteRuntime, type CredentialRequest } from "./runtime.ts";
import { Permissions, display, type Confirm } from "./permissions.ts";
import { localPath } from "./paths.ts";
import { password } from "./password.ts";

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
    if (request.temporaryOnly && !await this.dialogs.confirm(ctx)("Use a temporary sudo credential?", "The remembered sudo credential could not be read or removed. Enter a replacement for this runtime only? The old stored credential will be kept; use Clear sudo credential after the vault becomes available to remove it.", signal)) {
      await this.runtime.replyCredential(request.id); return;
    }
    let reuse = false;
    if (request.canReuseSSH) {
      const choice = await this.dialogs.select(ctx, `Sudo password for ${display(request.hostName)}`, ["Enter a separate sudo password", "Use this host's SSH password", "Cancel"], signal);
      if (!choice || choice === "Cancel") { await this.runtime.replyCredential(request.id); return; }
      reuse = choice === "Use this host's SSH password";
    }
    const value = reuse ? undefined : await this.dialogs.password(ctx, `${request.retry ? "Authentication failed. Retry: " : ""}${request.kind === "sudo" ? "Sudo password" : request.kind === "passphrase" ? "Private key passphrase" : "SSH password"} for ${display(request.hostName)}`, signal);
    if (value === undefined && !reuse) { await this.runtime.replyCredential(request.id); return; }
    const remember = !request.temporaryOnly && await this.dialogs.confirm(ctx)("Remember credential?", "Save in the operating system credential store? Choose No to keep it only until this extension runtime ends.", signal);
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
  const remember = await dialogs.confirm(ctx)("Remember credential?", "Save in the operating system credential store? Choose No for memory-only storage.");
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
    const selected = await dialogs.select(ctx, "Remote SSH", ["Add host", ...labels, "Revoke session permissions", "Close"]);
    if (!selected || selected === "Close") return;
    try {
      if (selected === "Revoke session permissions") { permissions.revoke(sessionId); ctx.ui.notify("SSH session permissions revoked", "info"); continue; }
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
      const action = await dialogs.select(ctx, `${display(host.name)} | ${status} | SFTP: ${sftp === undefined ? "not tested" : sftp ? "available" : "unavailable"}${changed ? " | reconnect required" : ""}${directory ? ` | ${display(directory)}` : ""}${error ? ` | ${display(error)}` : ""}`, ["Connect", "Test connection", "Disconnect", "Edit host", "Set login credential", "Authorize this session", "Clear sudo credential", "Reset host key trust", "Delete host", "Back"]);
      switch (action) {
        case "Connect":
          if (changed) await runtime.disconnect(sessionId, host.id);
          await runtime.setWorkspace(sessionId, host.id, undefined, dialogs.signal());
          ctx.ui.notify("SSH connection ready", "info"); break;
        case "Test connection": {
          ctx.ui.notify("Testing SSH and SFTP...", "info");
          const result = await runtime.test(host.id, dialogs.signal());
          ctx.ui.notify(`SSH: available | SFTP: ${result.sftp ? "available" : "unavailable"} | Home: ${display(result.home)}`, result.sftp ? "info" : "warning"); break;
        }
        case "Disconnect": await runtime.disconnect(sessionId, host.id); break;
        case "Edit host": {
          const draft = await draftHost(ctx, dialogs, runtime, host);
          if (draft) { await runtime.save(draft); permissions.revoke(sessionId); ctx.ui.notify("Host saved. Connection changes require reconnecting.", "info"); }
          break;
        }
        case "Set login credential": await setLoginCredential(ctx, dialogs, runtime, host); break;
        case "Authorize this session": await permissions.authorize(sessionId, runtime.profiles.chain(host.id), dialogs.confirm(ctx), dialogs.signal()); break;
        case "Clear sudo credential":
          if (await dialogs.confirm(ctx)("Clear sudo credential?", "Remove this plugin's cached and remembered sudo credential? Remote sudo timestamps are not changed.")) await runtime.sudoCredentials.remove(host.id);
          break;
        case "Reset host key trust":
          if (await dialogs.confirm(ctx)("Reset server identity trust?", `Verify ${display(host.hostname)}:${host.port} out of band first. The next connection will trust the presented key. Disconnect all uses of this endpoint, including jump hosts, before proceeding.`)) { await runtime.forgetHostKey(host.id); permissions.clear(); }
          break;
        case "Delete host":
          if (await dialogs.confirm(ctx)("Delete host?", `Remove ${display(host.name)} and its stored credentials? Disconnect it first.`)) { await runtime.deleteHost(host.id); permissions.clear(); }
          break;
      }
    } catch (error) { ctx.ui.notify(display(errorText(error)), "error"); }
  }
}
