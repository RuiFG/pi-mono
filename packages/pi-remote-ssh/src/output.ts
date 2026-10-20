import { StringDecoder } from "node:string_decoder";
import { closeSync, chmodSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type OutputStream = "stdout" | "stderr";
export type OutputSnapshot = {
  displayOutput: string;
  displayTruncated: boolean;
  fullOutputPath?: string;
  outputLogError?: string;
};

/** Trim only at a UTF-8 boundary; unlike StringDecoder.end(), safe for snapshots. */
export function byteTail(text: string, maxBytes: number) {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

/** Filtered textual output, in client-observed order. Disk failures never replay or fail a command. */
export class CommandOutput {
  private decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  private text = "";
  private truncated = false;
  private file?: string;
  private fd?: number;
  private logError?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private finished = false;
  constructor(private update?: (snapshot: OutputSnapshot) => void, private options: { maxBytes?: number; maxLines?: number; temporaryDirectory?: string } = {}) {}
  push(stream: OutputStream, data: Buffer) {
    if (!this.finished) this.append(this.decoders[stream].write(data));
  }
  private write(text: string) {
    if (this.fd === undefined || !text) return;
    const bytes = Buffer.from(text);
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(this.fd, bytes, offset, bytes.length - offset);
      if (!written) throw new Error("Output log write made no progress");
      offset += written;
    }
  }
  private failedLog() {
    this.logError = "Complete output could not be saved to the local temporary log.";
    this.close();
  }
  private close() {
    if (this.fd === undefined) return;
    const fd = this.fd; this.fd = undefined;
    try { closeSync(fd); } catch { this.logError = "The local output log could not be closed reliably."; }
  }
  private append(text: string) {
    if (!text) return;
    const combined = this.text + text;
    const maxBytes = this.options.maxBytes ?? 12 * 1024;
    let budget = maxBytes, retained = byteTail(combined, budget);
    // Control-heavy output expands in the JSON tool protocol. Spill before that
    // expansion could force toolResult to discard the only complete copy.
    while (Buffer.byteLength(JSON.stringify(retained)) > maxBytes + 2 && budget > 0) {
      budget = Math.floor(budget / 2); retained = byteTail(combined, budget);
    }
    const lines = retained.split("\n"), maxLines = this.options.maxLines ?? 2000;
    if (lines.length > maxLines) retained = lines.slice(-maxLines).join("\n");
    const overflow = retained !== combined;
    try {
      if (overflow && !this.file && !this.logError) {
        const directory = mkdtempSync(path.join(this.options.temporaryDirectory ?? tmpdir(), "pi-remote-ssh-output-"));
        if (process.platform !== "win32") chmodSync(directory, 0o700);
        this.file = path.join(directory, "output.log");
        this.fd = openSync(this.file, "wx", 0o600);
        this.write(this.text);
      }
      this.write(text);
    } catch { this.failedLog(); }
    this.text = retained;
    this.truncated ||= overflow;
    if (this.update && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.emit(); }, 100);
      this.timer.unref();
    }
  }
  snapshot(): OutputSnapshot {
    return { displayOutput: this.text, displayTruncated: this.truncated,
      // Explicit undefined clears an earlier advertised path after a later I/O failure.
      fullOutputPath: this.file && !this.logError ? this.file : undefined,
      outputLogError: this.logError };
  }
  private emit() {
    try { this.update?.(this.snapshot()); } catch { /* UI delivery cannot change the remote outcome. */ }
  }
  finish() {
    if (!this.finished) {
      for (const stream of ["stdout", "stderr"] as const) this.append(this.decoders[stream].end());
      this.finished = true;
      clearTimeout(this.timer); this.timer = undefined;
      this.close(); this.emit();
    }
    return this.snapshot();
  }
}
