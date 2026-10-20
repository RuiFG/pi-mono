import { stripVTControlCharacters } from "node:util";
import { Serial, SshError, checkAbort, type HostProfile } from "./domain.ts";
import { sudoIdentity } from "./sudo.ts";

export type Confirm = (title: string, message: string, signal?: AbortSignal) => Promise<boolean>;
export function display(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Grants belong to this runtime and session, never to persisted host configuration. */
export class Permissions {
  private grants = new Set<string>();
  private serial = new Serial();
  private generation = 0;
  private key(sessionId: string, chain: HostProfile[]) { return `${sessionId}:${sudoIdentity(chain)}`; }
  clear() { this.generation++; this.grants.clear(); }
  revoke(sessionId: string) {
    this.generation++;
    for (const key of this.grants) if (key.startsWith(`${sessionId}:`)) this.grants.delete(key);
  }
  has(sessionId: string, chain: HostProfile[]) { return this.grants.has(this.key(sessionId, chain)); }
  async authorize(sessionId: string, chain: HostProfile[], confirm: Confirm, signal?: AbortSignal) {
    const generation = this.generation;
    await this.serial.run(async () => {
      checkAbort(signal);
      if (generation !== this.generation) throw new SshError("PERMISSION_REVOKED", "SSH permissions changed; retry the operation");
      const key = this.key(sessionId, chain);
      if (this.grants.has(key)) return;
      const host = chain.at(-1)!;
      const route = chain.map(h => `${display(h.name)} (${display(h.username)}@${display(h.hostname)}:${h.port})`).join(" -> ");
      const allowed = await confirm("Authorize SSH host for this session?", `${route}\n\nAllow remote shell commands, file changes, transfers, and connection resets on ${display(host.name)} for this session. This includes destructive operations. Sudo and local file transfers require separate confirmation. This is not a filesystem sandbox.`, signal);
      checkAbort(signal);
      if (generation !== this.generation) throw new SshError("PERMISSION_REVOKED", "SSH permissions changed; retry the operation");
      if (!allowed) throw new SshError("PERMISSION_DENIED", "SSH host authorization was declined or is unavailable in this mode");
      this.grants.add(key);
    });
  }
  async sudo(host: HostProfile, command: string, confirm: Confirm, signal?: AbortSignal) {
    checkAbort(signal);
    if (!await confirm("Run this command as root?", `${display(host.name)} (${display(host.username)}@${display(host.hostname)}:${host.port})\n\n${display(command)}\n\nThe entire command, including pipelines and redirections, will run through sudo as root.`, signal)) {
      throw new SshError("PERMISSION_DENIED", "Sudo was not approved");
    }
    checkAbort(signal);
  }
  async transfer(local: string, remote: string, upload: boolean, overwrite: boolean, confirm: Confirm, signal?: AbortSignal) {
    checkAbort(signal);
    if (!await confirm(upload ? "Upload this local file?" : "Download to this local file?", `${display(local)}\n${upload ? "->" : "<-"} ${display(remote)}\nOverwrite: ${overwrite ? "yes" : "no"}`, signal)) {
      throw new SshError("PERMISSION_DENIED", "Local file transfer was not approved");
    }
    checkAbort(signal);
  }
}
