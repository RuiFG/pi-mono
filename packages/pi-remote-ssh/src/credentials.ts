import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { z } from "zod";
import { Serial, SshError } from "./domain.ts";
import { atomicJson, locked } from "./storage.ts";

export interface SecretBackend {
  get(id: string): Promise<string | undefined>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}
const MAX_VAULT_BYTES = 4 * 1024 * 1024;
const AAD = Buffer.from("pi-remote-ssh:credential-vault:v1");
const Entries = z.record(z.uuid(), z.string().max(64 * 1024));
const Envelope = z.object({ version: z.literal(1), algorithm: z.literal("aes-256-gcm"), nonce: z.string(), tag: z.string(), ciphertext: z.string() }).strict();

/** Local auto-unlock: possession of both key and vault permits decryption. Not an OS vault. */
export class EncryptedFileSecrets implements SecretBackend {
  private readonly serial = new Serial();
  private readonly file: string;
  private readonly keyFile: string;
  constructor(private readonly directory: string) {
    this.file = path.join(directory, "vault.json");
    this.keyFile = path.join(directory, "key");
  }
  private validateId(id: string) {
    if (!z.uuid().safeParse(id).success) throw new SshError("INVALID_CREDENTIAL_ID", "Invalid credential ID");
  }
  private async read(file: string, limit: number): Promise<Buffer | undefined> {
    try {
      const entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe vault file");
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > limit || process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("Unsafe vault file");
        return await handle.readFile();
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private decode(value: string, length?: number) {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value || length !== undefined && bytes.length !== length) throw new Error("Invalid vault encoding");
    return bytes;
  }
  private decrypt(bytes: Buffer, key: Buffer): Record<string, string> {
    let pending: Buffer | undefined, plaintext: Buffer | undefined;
    try {
      const envelope = Envelope.parse(JSON.parse(bytes.toString("utf8")));
      const decipher = createDecipheriv("aes-256-gcm", key, this.decode(envelope.nonce, 12));
      decipher.setAAD(AAD); decipher.setAuthTag(this.decode(envelope.tag, 16));
      pending = decipher.update(this.decode(envelope.ciphertext));
      // Do not parse unauthenticated plaintext: final() must verify the GCM tag first.
      plaintext = Buffer.concat([pending, decipher.final()]);
      return Entries.parse(JSON.parse(plaintext.toString("utf8")));
    } catch { throw new Error("Encrypted vault authentication or format is invalid"); }
    finally { pending?.fill(0); plaintext?.fill(0); }
  }
  private async encrypt(entries: Record<string, string>, key: Buffer) {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(entries));
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope = { version: 1, algorithm: "aes-256-gcm", nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
      // atomicJson uses indented JSON; reserve space for its formatting.
      if (Buffer.byteLength(JSON.stringify(envelope, null, 2)) + 1 > MAX_VAULT_BYTES) throw new Error("Vault size limit exceeded");
      await atomicJson(this.file, envelope);
    } finally { plaintext.fill(0); }
  }
  private async access<T>(mode: "read" | "set" | "delete", operation: (entries: Record<string, string>) => T): Promise<T> {
    return this.serial.run(async () => {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const info = await lstat(this.directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe vault directory");
        if (process.platform !== "win32") await chmod(this.directory, 0o700);
        return await locked(this.file, async () => {
          const bytes = await this.read(this.file, MAX_VAULT_BYTES);
          if (!bytes && mode !== "set") return operation({});
          let key = await this.read(this.keyFile, 32);
          try {
            if (!key) {
              if (bytes) throw new Error("Missing key for existing vault");
              key = randomBytes(32);
              const temporary = `${this.keyFile}.${randomUUID()}.tmp`;
              try {
                await writeFile(temporary, key, { flag: "wx", mode: 0o600 });
                await rename(temporary, this.keyFile);
              } finally { await rm(temporary, { force: true }); }
            }
            if (key.length !== 32) throw new Error("Invalid encryption key");
            const entries = bytes ? this.decrypt(bytes, key) : {};
            const result = operation(entries);
            if (mode !== "read") await this.encrypt(entries, key);
            return result;
          } finally { key?.fill(0); }
        });
      } catch {
        // Never expose decrypted values, parser input, or crypto internals in tool/UI errors.
        throw new SshError("VAULT_UNAVAILABLE", "Encrypted credential storage is unavailable or damaged. Check file permissions and restore the matching key and vault together if needed. Temporary use remains available.");
      }
    });
  }
  async get(id: string) {
    this.validateId(id);
    return this.access("read", entries => entries[id]);
  }
  async set(id: string, value: string) {
    this.validateId(id);
    if (Buffer.byteLength(value) > 64 * 1024) throw new SshError("INVALID_CREDENTIAL", "Credential exceeds the 64 KiB limit");
    await this.access("set", entries => { entries[id] = value; });
  }
  async delete(id: string) {
    this.validateId(id);
    await this.access("delete", entries => { delete entries[id]; });
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
