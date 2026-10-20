import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Profiles, HostKeys } from "./storage.ts";
import { Credentials, EncryptedFileSecrets, type SecretBackend } from "./credentials.ts";
import { Connector, type Connection, type ExecOptions } from "./transport.ts";
import { SudoCredentials, sudoIdentity } from "./sudo.ts";
import { Serial, SshError, checkAbort, type HostDraft, type HostProfile, type HostStatus } from "./domain.ts";
import { remotePath } from "./paths.ts";
export type CredentialRequest = { id: string; hostId: string; hostName: string; kind: "password" | "passphrase" | "sudo"; sessionId: string; canReuseSSH?: boolean; retry?: boolean; temporaryOnly?: boolean };
type Pending = CredentialRequest & { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; reply?: (value: string | undefined, remember: boolean, reuseSSH: boolean) => Promise<void> };
type Slot = { chain: HostProfile[]; connection?: Connection; pending?: Promise<Connection>; controller: AbortController; status: HostStatus["status"]; error?: string };
type SessionState = { directories: Map<string, string>; blocked: Set<string>; slots: Map<string, Slot>; hostLocks: Map<string, Serial> };
export type StateView = { hosts: HostStatus[]; requests: CredentialRequest[] };

export class RemoteRuntime {
  readonly profiles: Profiles;
  readonly keys: HostKeys;
  readonly credentials: Credentials;
  readonly sudoCredentials: SudoCredentials;
  private readonly connector: Connector;
  private readonly sessions = new Map<string, SessionState>();
  private readonly requests = new Map<string, Pending>();
  private readonly events = new EventEmitter();
  private readonly deleting = new Set<string>();
  private readonly configSerial = new Serial();
  private closed = false;

  constructor(directory: string, secrets?: SecretBackend, connector?: Connector) {
    this.profiles = new Profiles(path.join(directory, "hosts.json"));
    this.keys = new HostKeys(path.join(directory, "known-hosts.json"));
    this.credentials = new Credentials(secrets ?? new EncryptedFileSecrets(path.join(directory, "credentials")));
    this.sudoCredentials = new SudoCredentials(path.join(directory, "sudo-credentials.json"), this.credentials);
    this.connector = connector ?? new Connector(this.keys);
    this.events.setMaxListeners(0);
  }
  async load() { await Promise.all([this.profiles.load(), this.keys.load(), this.sudoCredentials.load()]); }
  onChange(listener: () => void) { this.events.on("change", listener); return () => { this.events.off("change", listener); }; }
  private changed() { this.events.emit("change"); }
  session(id: string) {
    if (this.closed) throw new SshError("SESSION_CLOSED", "SSH runtime has been closed");
    let state = this.sessions.get(id);
    if (!state) {
      state = { directories: new Map(), blocked: new Set(), slots: new Map(), hostLocks: new Map() };
      this.sessions.set(id, state);
    }
    return state;
  }
  resolve(id: string, hostId: string): { host: HostProfile; directory?: string } {
    const state = this.session(id);
    const host = this.profiles.get(hostId);
    if (host.id !== hostId) throw new SshError("HOST_NOT_FOUND", "Use the hostId returned by ssh_list_hosts");
    return { host, directory: state.directories.get(host.id) };
  }
  state(id?: string): StateView {
    const session = id ? this.session(id) : undefined;
    return {
      hosts: this.profiles.list().map(host => {
        const slot = session?.slots.get(host.id);
        const changed = !!slot && slot.chain.some(snapshot => {
          try { return this.profiles.get(snapshot.id).revision !== snapshot.revision; } catch { return true; }
        });
        return { host, status: slot?.status ?? "disconnected", directory: session?.directories.get(host.id), home: slot?.connection?.home,
          changed, sftp: slot?.connection?.sftpAvailable, error: slot?.error };
      }),
      requests: [...this.requests.values()].map(({ id, hostId, hostName, kind, sessionId, canReuseSSH, retry, temporaryOnly }) => ({ id, hostId, hostName, kind, sessionId, canReuseSSH, retry, temporaryOnly })),
    };
  }
  private used(id: string) {
    for (const session of this.sessions.values()) for (const slot of session.slots.values()) {
      if ((slot.status === "connected" || slot.status === "connecting") && slot.chain.some(host => host.id === id)) return true;
    }
    return false;
  }
  async save(draft: HostDraft, secret?: string, remember?: boolean) {
    return this.configSerial.run(async () => {
      const old = draft.id ? this.profiles.get(draft.id) : undefined;
      let credential: { id?: string; remembered: boolean } | undefined;
      if (secret !== undefined) credential = await this.credentials.create(secret, remember ?? false);
      else if (old && (old.hostname !== draft.hostname || old.port !== (draft.port ?? 22) || old.username !== draft.username || old.jumpHostId !== draft.jumpHostId)) {
        credential = { remembered: false };
      }
      else if (old && (old.auth !== draft.auth || old.privateKeyPath !== draft.privateKeyPath || remember !== undefined && remember !== old.remembered)) {
        if (remember && old.auth === draft.auth) {
          const value = await this.credentials.get(old.credentialId, old.remembered);
          if (value === undefined) throw new SshError("CREDENTIAL_REQUIRED", "Enter the credential before remembering it");
          credential = await this.credentials.create(value, true);
        } else if (old.auth === draft.auth && old.privateKeyPath === draft.privateKeyPath) {
          const value = await this.credentials.get(old.credentialId, old.remembered);
          credential = value === undefined ? { remembered: false } : await this.credentials.create(value, false);
        } else credential = { remembered: false };
      }
      try {
        const host = await this.profiles.save(draft, credential);
        if (credential && old?.credentialId) await this.credentials.remove(old.credentialId, old.remembered).catch(() => {});
        this.changed(); return host;
      } catch (error) {
        if (credential) await this.credentials.remove(credential.id, credential.remembered).catch(() => {});
        throw error;
      }
    });
  }
  async deleteHost(id: string) {
    return this.configSerial.run(async () => {
      if (this.used(id)) throw new SshError("HOST_IN_USE", "Host is in use by an active session");
      const host = this.profiles.get(id);
      this.deleting.add(id);
      try {
        await this.profiles.remove(id);
        await this.credentials.remove(host.credentialId, host.remembered);
        await this.sudoCredentials.remove(id);
        for (const state of this.sessions.values()) {
          state.directories.delete(id); state.slots.delete(id); state.blocked.delete(id);
        }
        this.changed();
      } finally { this.deleting.delete(id); }
    });
  }
  async forgetHostKey(id: string) {
    const host = this.profiles.get(id);
    const aliases = this.profiles.list().filter(candidate => candidate.hostname.toLowerCase() === host.hostname.toLowerCase() && candidate.port === host.port);
    if (aliases.some(candidate => this.used(candidate.id))) throw new SshError("HOST_IN_USE", "Disconnect sessions using this endpoint before updating its identity record");
    await this.keys.forget(host);
  }
  private async secret(host: HostProfile, sessionId: string, signal: AbortSignal, required = false): Promise<string | undefined> {
    let value = await this.credentials.get(host.credentialId, host.remembered);
    if (value !== undefined || !required) return value;
    checkAbort(signal);
    await new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const abort = () => { const pending = this.requests.get(id); if (pending) { clearTimeout(pending.timer); this.requests.delete(id); this.changed(); } reject(new SshError("CANCELLED", "Credential input cancelled")); };
      const cleanup = () => signal.removeEventListener("abort", abort);
      const timer = setTimeout(() => { cleanup(); this.requests.delete(id); this.changed(); reject(new SshError("CREDENTIAL_REQUIRED", `Enter credentials for ${host.name} in /ssh and retry`)); }, 120_000);
      this.requests.set(id, { id, hostId: host.id, hostName: host.name, kind: host.auth === "key" ? "passphrase" : "password", sessionId,
        timer, resolve: () => { cleanup(); resolve(); }, reject: error => { cleanup(); reject(error); } });
      signal.addEventListener("abort", abort, { once: true }); this.changed();
      if (signal.aborted) abort();
    });
    const updated = this.profiles.get(host.id);
    value = await this.credentials.get(updated.credentialId, updated.remembered);
    // A credential-only update during login belongs to the connection being established.
    if (host.hostname !== updated.hostname || host.username !== updated.username || host.auth !== updated.auth || host.privateKeyPath !== updated.privateKeyPath || host.port !== updated.port || host.jumpHostId !== updated.jumpHostId) {
      throw new SshError("HOST_CHANGED", "Host configuration changed while entering credentials; reconnect and retry");
    }
    Object.assign(host, updated);
    return value;
  }
  async replyCredential(id: string, value?: string, remember = false, reuseSSH = false) {
    const request = this.requests.get(id);
    if (!request) return;
    if (request.reply) { await request.reply(value, remember, reuseSSH); return; }
    if (reuseSSH) throw new SshError("INVALID_CREDENTIAL", "SSH credential reuse is only available for sudo requests");
    if (value === undefined) {
      clearTimeout(request.timer); this.requests.delete(id); request.reject(new SshError("CREDENTIAL_CANCELLED", "Credential input cancelled")); this.changed(); return;
    }
    const host = this.profiles.get(request.hostId);
    const { revision: _revision, credentialId: _credential, remembered: _remembered, ...draft } = host;
    await this.save(draft, value, remember);
    if (!this.requests.has(id)) return;
    clearTimeout(request.timer); this.requests.delete(id); request.resolve(); this.changed();
  }
  async execSudo(sessionId: string, connection: Connection, command: string, options: ExecOptions) {
    const host = connection.chain.at(-1)!;
    const identity = sudoIdentity(connection.chain);
    const validate = () => {
      if (sudoIdentity(this.profiles.chain(host.id)) !== identity) throw new SshError("HOST_CHANGED", "Reconnect this host before using sudo after configuration changes");
    };
    validate();
    let authenticated = false;
    try {
      const result = await connection.exec(command, { ...options, sudo: async (signal, retry) => {
        validate(); checkAbort(signal);
        let temporaryOnly = false;
        try {
          if (retry) await this.sudoCredentials.remove(host.id, identity);
          const cached = await this.sudoCredentials.get(host.id, identity);
          checkAbort(signal);
          if (cached !== undefined) return cached;
        } catch (error) {
          if (!(error instanceof SshError) || error.code !== "VAULT_UNAVAILABLE") throw error;
          temporaryOnly = true;
        }
        const current = this.profiles.get(host.id);
        let canReuseSSH = false;
        if (!retry && current.auth === "password") {
          try { canReuseSSH = await this.credentials.get(current.credentialId, current.remembered) !== undefined; }
          catch (error) { if (!(error instanceof SshError) || error.code !== "VAULT_UNAVAILABLE") throw error; }
        }
        checkAbort(signal);
        await new Promise<void>((resolve, reject) => {
          const id = randomUUID();
          const finish = (error?: Error) => {
            const pending = this.requests.get(id);
            if (!pending) return;
            clearTimeout(pending.timer); signal.removeEventListener("abort", abort);
            this.requests.delete(id); this.changed(); error ? reject(error) : resolve();
          };
          const abort = () => finish(new SshError("CANCELLED", "Sudo credential input cancelled"));
          const timer = setTimeout(() => finish(new SshError("CREDENTIAL_REQUIRED", "Enter the sudo password in the TUI and retry")), 120_000);
          this.requests.set(id, {
            id, hostId: host.id, hostName: host.name, kind: "sudo", sessionId, canReuseSSH, retry, temporaryOnly, timer,
            resolve: () => finish(), reject: error => finish(error),
            reply: async (value, remember, reuseSSH) => {
              if (value === undefined && !reuseSSH) { finish(new SshError("CREDENTIAL_CANCELLED", "Sudo credential input cancelled")); return; }
              validate(); checkAbort(signal);
              if (reuseSSH) {
                if (!canReuseSSH) throw new SshError("INVALID_CREDENTIAL", "SSH password reuse is unavailable");
                const current = this.profiles.get(host.id);
                value = await this.credentials.get(current.credentialId, current.remembered);
                if (value === undefined) throw new SshError("CREDENTIAL_REQUIRED", "SSH password is no longer available");
              }
              if (value === undefined) { finish(new SshError("CREDENTIAL_CANCELLED", "Sudo credential input cancelled")); return; }
              if (/[\r\n\0]/.test(value)) throw new SshError("INVALID_CREDENTIAL", "Sudo passwords must not contain newline or NUL characters");
              checkAbort(signal);
              if (temporaryOnly) {
                if (remember) throw new SshError("VAULT_UNAVAILABLE", "Recovery credentials can only be used temporarily");
                await this.sudoCredentials.overrideForRuntime(host.id, identity, value);
              } else await this.sudoCredentials.set(host.id, identity, value, remember);
              if (signal.aborted) {
                try { await this.sudoCredentials.remove(host.id, identity); }
                catch (error) { if (!(error instanceof SshError) || error.code !== "VAULT_UNAVAILABLE") throw error; }
                checkAbort(signal);
              }
              finish();
            },
          });
          signal.addEventListener("abort", abort, { once: true }); this.changed();
          if (signal.aborted) abort();
        });
        checkAbort(signal); validate();
        return this.sudoCredentials.get(host.id, identity);
      } });
      authenticated = result.elevated === true;
      return result;
    } finally {
      if (!authenticated) {
        try { await this.sudoCredentials.remove(host.id, identity); }
        catch (error) {
          // References remain for later cleanup; vault failure must not hide cancellation or an unknown outcome.
          if (!(error instanceof SshError) || error.code !== "VAULT_UNAVAILABLE") throw error;
        }
      }
    }
  }
  async connection(id: string, hostId: string, explicit: boolean, signal?: AbortSignal): Promise<Connection> {
    const state = this.session(id);
    if (explicit) state.blocked.delete(hostId);
    if (state.blocked.has(hostId)) throw new SshError("MANUALLY_DISCONNECTED", "This host was explicitly disconnected; use ssh_set_workspace to reconnect");
    const previous = state.slots.get(hostId);
    if (previous?.connection?.alive) return previous.connection;
    if (previous?.pending) return previous.pending;
    const chain = this.profiles.chain(hostId);
    if (chain.some(host => this.deleting.has(host.id))) throw new SshError("HOST_IN_USE", "Host configuration is being removed");
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const slot: Slot = { chain, controller, status: "connecting" };
    state.slots.set(hostId, slot); this.changed();
    const pending = (async () => {
      let connection: Connection | undefined;
      try {
        connection = await this.connector.connect(chain, (host, required) => this.secret(host, id, combined, required), combined);
        checkAbort(combined);
        const priorDirectory = state.directories.get(hostId);
        if (priorDirectory) await connection.directory(priorDirectory, combined);
        else state.directories.set(hostId, connection.home);
        checkAbort(combined);
        slot.connection = connection; slot.status = "connected";
        connection.onClose(() => {
          if (state.slots.get(hostId) !== slot || state.blocked.has(hostId)) return;
          slot.status = "error"; slot.error = "Connection lost; the next operation can reconnect"; this.changed();
        });
        this.changed(); return connection;
      } catch (error) {
        connection?.close(); slot.status = "error";
        slot.error = error instanceof Error ? error.message : "Connection failed";
        this.changed(); throw error;
      } finally { slot.pending = undefined; }
    })();
    slot.pending = pending;
    return pending;
  }
  private hostLock(state: SessionState, hostId: string) {
    let lock = state.hostLocks.get(hostId);
    if (!lock) { lock = new Serial(); state.hostLocks.set(hostId, lock); }
    return lock;
  }
  async setWorkspace(id: string, hostId: string, directory: string | undefined, signal?: AbortSignal) {
    const state = this.session(id);
    return this.hostLock(state, hostId).run(async () => {
      const { host } = this.resolve(id, hostId);
      const connection = await this.connection(id, host.id, true, signal);
      const next = remotePath(directory, state.directories.get(host.id) ?? connection.home, connection.home);
      const resolved = await connection.directory(next, signal);
      checkAbort(signal);
      state.directories.set(host.id, resolved); this.changed();
      return { hostId: host.id, hostName: host.name, directory: resolved };
    });
  }
  async disconnect(id: string, hostId: string) {
    const state = this.session(id);
    return this.hostLock(state, hostId).run(async () => {
      state.blocked.add(hostId);
      const slot = state.slots.get(hostId);
      slot?.controller.abort(); slot?.connection?.close();
      state.slots.delete(hostId); state.directories.delete(hostId); this.changed();
    });
  }
  async reset(id: string, hostId: string, signal?: AbortSignal) {
    const state = this.session(id);
    if (state.blocked.has(hostId)) throw new SshError("MANUALLY_DISCONNECTED", "Use ssh_set_workspace to reconnect a manually disconnected host");
    const slot = state.slots.get(hostId);
    slot?.controller.abort(); slot?.connection?.close(); state.slots.delete(hostId);
    await this.connection(id, hostId, false, signal);
    this.changed(); return { hostId, directory: state.directories.get(hostId) };
  }
  async test(hostId: string, signal?: AbortSignal) {
    const id = `test:${randomUUID()}`;
    try {
      const connection = await this.connection(id, hostId, true, signal);
      return { home: connection.home, exec: true, sftp: connection.sftpAvailable, hops: connection.chain.map(host => host.name) };
    } finally { this.release(id); }
  }
  release(id: string) {
    for (const request of [...this.requests.values()]) if (request.sessionId === id) {
      request.reject(new SshError("CANCELLED", "Session closed"));
      clearTimeout(request.timer); this.requests.delete(request.id);
    }
    const state = this.sessions.get(id);
    if (!state) return;
    for (const slot of state.slots.values()) { slot.controller.abort(); slot.connection?.close(); }
    this.sessions.delete(id); this.changed();
  }
  close() {
    if (this.closed) return;
    for (const request of [...this.requests.values()]) {
      request.reject(new SshError("CANCELLED", "SSH runtime closed"));
      clearTimeout(request.timer); this.requests.delete(request.id);
    }
    for (const id of this.sessions.keys()) this.release(id);
    this.closed = true;
    this.credentials.clear();
    this.events.removeAllListeners();
  }
}
