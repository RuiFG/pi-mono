import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SshError } from "./domain.ts";

export interface SecretBackend {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}
const SERVICE = "studio.ruifg.pi-remote-ssh";
export class SystemSecrets implements SecretBackend {
  constructor(private readonly directory: string) {}
  private file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new SshError("INVALID_CREDENTIAL_ID", "Invalid credential ID");
    return path.join(this.directory, `${id}.dpapi`);
  }
  private async keychain(id: string) {
    this.file(id);
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry(SERVICE, id, { linux: { store: "secret-service" } });
    } catch {
      throw new SshError("VAULT_UNAVAILABLE", "System credential storage is unavailable. Use a temporary credential instead.");
    }
  }
  private async vault<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch { throw new SshError("VAULT_UNAVAILABLE", "System credential storage failed or is locked. Use a temporary credential instead."); }
  }
  private async dpapi(bytes: Buffer, decrypt: boolean): Promise<Buffer> {
    const method = decrypt ? "Unprotect" : "Protect";
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $m=New-Object System.IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($m); $r=[Security.Cryptography.ProtectedData]::${method}($m.ToArray(),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::OpenStandardOutput().Write($r,0,$r.Length)`;
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => { child.kill(); reject(new SshError("VAULT_UNAVAILABLE", "Credential store operation timed out")); }, 15_000);
      child.stdout.on("data", chunk => chunks.push(chunk));
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", () => { clearTimeout(timer); reject(new SshError("VAULT_UNAVAILABLE", "Windows credential protection is unavailable")); });
      child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new SshError("VAULT_UNAVAILABLE", "Windows credential protection failed")); });
      child.stdin.end(bytes);
    });
  }
  async get(id: string) {
    if (process.platform !== "win32") return this.vault(async () => (await (await this.keychain(id)).getPassword(AbortSignal.timeout(15_000))) ?? undefined);
    try { return (await this.dpapi(await readFile(this.file(id)), true)).toString("utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async set(id: string, value: string) {
    if (process.platform !== "win32") return this.vault(async () => { await (await this.keychain(id)).setPassword(value, AbortSignal.timeout(15_000)); });
    const ciphertext = await this.dpapi(Buffer.from(value), false);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.file(id), ciphertext, { flag: "wx", mode: 0o600 });
  }
  async delete(id: string) {
    if (process.platform !== "win32") return this.vault(async () => { await (await this.keychain(id)).deletePassword(AbortSignal.timeout(15_000)); });
    await rm(this.file(id), { force: true });
  }
}
export class Credentials {
  private memory = new Map<string, string>();
  private closed = false;
  constructor(private readonly backend: SecretBackend) {}
  async create(value: string, remember: boolean) {
    if (this.closed) throw new SshError("CANCELLED", "Credential store has been closed");
    const id = randomUUID();
    if (remember) await this.backend.set(id, value);
    if (this.closed) {
      if (remember) await this.backend.delete(id);
      throw new SshError("CANCELLED", "Credential save cancelled during shutdown");
    }
    this.memory.set(id, value);
    return { id, remembered: remember };
  }
  async get(id: string | undefined, remembered: boolean) {
    if (!id || this.closed) return undefined;
    if (this.memory.has(id)) return this.memory.get(id);
    if (!remembered) return undefined;
    const value = await this.backend.get(id);
    if (this.closed) return undefined;
    if (value !== undefined) this.memory.set(id, value);
    return value;
  }
  clear() { this.closed = true; this.memory.clear(); }
  async remove(id: string | undefined, remembered: boolean) {
    if (!id) return;
    if (remembered) await this.backend.delete(id);
    this.memory.delete(id);
  }
}
