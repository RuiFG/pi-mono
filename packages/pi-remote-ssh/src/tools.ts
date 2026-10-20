import { z } from "zod";
import type { TSchema } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import nodePath from "node:path";
import { RemoteRuntime } from "./runtime.ts";
import { SshError, failure, checkAbort } from "./domain.ts";
import { localPath, remotePath, quote } from "./paths.ts";
import { sudoIdentity } from "./sudo.ts";
import * as files from "./files.ts";
import { CommandOutput, byteTail } from "./output.ts";
import { sshRenderers, type NativeRenderers } from "./render.ts";

const hostId = z.string().uuid().describe("Required stable host ID returned by ssh_list_hosts. Names are not accepted.");
const remote = z.string().min(1).refine(v => !v.includes("\0"), "Path contains NUL");
const common = { hostId };
const limit = (value: number, max: number) => z.number().int().min(1).max(max).default(value);
export const schemas = {
  ssh_list_hosts: z.object({}).strict(),
  ssh_set_workspace: z.object({ ...common, path: remote.optional() }).strict(),
  ssh_shell_exec: z.object({ ...common, command: z.string().min(1).max(128 * 1024).refine(v => !v.includes("\0"), "Command contains NUL"), sudo: z.boolean().default(false), stdin: z.string().max(4 * 1024 * 1024).optional(), timeoutMs: z.number().int().min(0).max(2_147_483_647).default(120_000) }).strict(),
  ssh_read_file: z.object({ ...common, path: remote, startLine: limit(1, 10_000_000), limit: limit(2000, 10_000) }).strict(),
  ssh_write_file: z.object({ ...common, path: remote, content: z.string().max(4 * 1024 * 1024), overwrite: z.boolean().default(false) }).strict(),
  ssh_grep: z.object({ ...common, path: remote.optional(), pattern: z.string().min(1).max(8192), include: z.string().optional(), ignoreCase: z.boolean().default(false), limit: limit(200, 2000) }).strict(),
  ssh_glob: z.object({ ...common, path: remote.optional(), pattern: z.string().min(1).max(8192), limit: limit(500, 5000) }).strict(),
  ssh_upload_file: z.object({ ...common, localPath: remote, remotePath: remote, overwrite: z.boolean().default(false) }).strict(),
  ssh_download_file: z.object({ ...common, remotePath: remote, localPath: remote, overwrite: z.boolean().default(false) }).strict(),
  ssh_reset_connection: z.object(common).strict(),
};
export type ToolName = keyof typeof schemas;
export const READ_ONLY = new Set<ToolName>(["ssh_list_hosts", "ssh_set_workspace", "ssh_read_file", "ssh_grep", "ssh_glob"]);
export const descriptions: Record<ToolName, string> = {
  ssh_list_hosts: "List configured SSH hosts with stable IDs, connection status and this session's per-host working directories. Never returns credentials. All other SSH tools require an explicit hostId; there is no default host.",
  ssh_set_workspace: "Connect or explicitly reconnect one host and set its remote working directory after validation. First connection starts at the login home. Omitting path keeps the current directory. Does not affect other hosts.",
  ssh_shell_exec: "Execute a command in this host's working directory. Returns stdout, stderr, exitCode and outcome. Default timeout is 120 seconds; 0 disables it. sudo:true runs the entire command as root without an approval dialog; a password is requested only when needed. Never include passwords in command or stdin. Temporary cd does not change the stored directory. Never replay an unknown outcome automatically.",
  ssh_read_file: "Read a remote text file through SFTP with 1-based startLine and bounded output. Use ssh_download_file for binary data.",
  ssh_write_file: "Write remote UTF-8 text via SFTP using a temporary file. Requires an existing parent directory and explicit overwrite:true to replace a file.",
  ssh_grep: "Search remote file content using the server's existing grep extended regular expressions. Optional include filters filenames. Output is bounded; no helper is installed remotely.",
  ssh_glob: "Find relative paths through SFTP using glob patterns, including **. Does not recurse into directory symlinks. Results and traversal are bounded.",
  ssh_upload_file: "Stream one local file, including binary data, to an exact remote path via SFTP. Local paths are relative to the Pi working directory. Transfers directly without a confirmation dialog. overwrite defaults to false.",
  ssh_download_file: "Stream one remote file to an exact local path via SFTP. Local paths are relative to the Pi working directory. Transfers directly without a confirmation dialog. overwrite defaults to false.",
  ssh_reset_connection: "Reset this session's connection to one host and revalidate its directory. Does not replay commands or guarantee termination of remote processes. Manually disconnected hosts require ssh_set_workspace instead.",
};
export type ToolEnvironment = {
  runtime: RemoteRuntime;
  sessionId: string;
  cwd: string;
  signal?: AbortSignal;
  progress?: files.Progress;
  report?: (value: Record<string, unknown>) => void;
};

// Each field is consumed only in its corresponding validated tool branch.
type ToolArgs = z.output<typeof schemas.ssh_shell_exec>
  & z.output<typeof schemas.ssh_read_file>
  & z.output<typeof schemas.ssh_write_file>
  & z.output<typeof schemas.ssh_grep>
  & z.output<typeof schemas.ssh_upload_file>;

// Runtime Zod parsing applies defaults and rejects unknown fields even for programmatic calls.
export async function executeTool(name: ToolName, input: unknown, env: ToolEnvironment): Promise<Record<string, unknown>> {
  // Each schema has different fields; all accesses below follow a validated tool-name branch.
  const args = schemas[name].parse(input) as ToolArgs;
  const { runtime, sessionId, signal } = env;
  checkAbort(signal);
  await runtime.profiles.load();
  if (name === "ssh_list_hosts") {
    return { ok: true, hosts: runtime.state(sessionId).hosts.map(({ host, ...status }) => ({ id: host.id, name: host.name, hostname: host.hostname, port: host.port, username: host.username, auth: host.auth, jumpHostId: host.jumpHostId, ...status })) };
  }
  const selected = runtime.resolve(sessionId, args.hostId);
  env.report?.({ hostId: selected.host.id, hostName: selected.host.name, directory: selected.directory });
  const chain = runtime.profiles.chain(selected.host.id);
  const identity = sudoIdentity(chain);
  let local: string | undefined;
  if (name === "ssh_upload_file" || name === "ssh_download_file") {
    const absolute = localPath(args.localPath, env.cwd);
    local = name === "ssh_upload_file" ? await realpath(absolute) : nodePath.join(await realpath(nodePath.dirname(absolute)), nodePath.basename(absolute));
  }
  checkAbort(signal);
  await runtime.profiles.load();
  if (identity !== sudoIdentity(runtime.profiles.chain(selected.host.id))) throw new SshError("HOST_CHANGED", "Host configuration changed while preparing the operation; retry with the current configuration");
  if (name === "ssh_reset_connection") return { ok: true, ...await runtime.reset(sessionId, selected.host.id, signal) };
  const status = runtime.state(sessionId).hosts.find(item => item.host.id === selected.host.id);
  if (status?.changed) throw new SshError("HOST_CHANGED", "Use ssh_reset_connection for this host to apply its updated configuration");
  const connection = await runtime.connection(sessionId, selected.host.id, name === "ssh_set_workspace", signal);
  if (sudoIdentity(connection.chain) !== identity) throw new SshError("HOST_CHANGED", "Connection identity no longer matches the selected host");
  checkAbort(signal);
  const directory = selected.directory ?? connection.home;
  env.report?.({ directory });
  const resolve = (value?: string) => remotePath(value, directory, connection.home);
  const path = resolve(args.path);
  let result: object;
  switch (name) {
    case "ssh_set_workspace": result = await runtime.setWorkspace(sessionId, selected.host.id, path, signal); break;
    case "ssh_shell_exec": {
      const command = `cd -- ${quote(directory)} || exit $?\n${args.command}`;
      const capture = new CommandOutput(snapshot => env.report?.(snapshot));
      const options = { signal, stdin: args.stdin, timeoutMs: args.timeoutMs, onOutput: capture.push.bind(capture) };
      try {
        const output = args.sudo ? await runtime.execSudo(sessionId, connection, command, options) : await connection.exec(command, options);
        return { ok: output.exitCode === 0 && output.outcome === "exited" && !output.timedOut && !output.cancelled, hostId: selected.host.id, directory, ...output, ...capture.finish() };
      } catch (error) {
        return { ...failure(error), hostId: selected.host.id, directory, outcome: "unknown", exitCode: null, ...capture.finish() };
      } finally { capture.finish(); }
    }
    case "ssh_read_file": result = await files.readText(connection, path, args.startLine, args.limit, signal); break;
    case "ssh_write_file": result = await files.upload(connection, Buffer.from(args.content), path, args.overwrite, signal); break;
    case "ssh_grep": result = await files.grep(connection, path, args.pattern, args.include, args.ignoreCase, args.limit, signal); break;
    case "ssh_glob": result = await files.glob(connection, path, args.pattern, args.limit, signal); break;
    case "ssh_upload_file": result = await files.upload(connection, local!, resolve(args.remotePath), args.overwrite, signal, env.progress); break;
    case "ssh_download_file": result = await files.download(connection, resolve(args.remotePath), local!, args.overwrite, signal, env.progress); break;
  }
  return { ok: true, hostId: selected.host.id, directory, ...result };
}

export function toolResult(value: Record<string, unknown>) {
  // Preserve separate shell streams and the display tail even when JSON escaping
  // expands the result. Keep log paths and outcome metadata outside truncation.
  if (typeof value.stdout === "string" || typeof value.stderr === "string" || typeof value.displayOutput === "string") {
    value = { ...value };
    for (let budget = 8192; Buffer.byteLength(JSON.stringify(value)) > 60 * 1024 && budget >= 256; budget /= 2) {
      for (const key of ["stdout", "stderr", "displayOutput"] as const) {
        if (typeof value[key] === "string" && Buffer.byteLength(value[key]) > budget) {
          value[key] = key === "displayOutput" ? byteTail(value[key], budget) : Buffer.from(value[key]).subarray(0, budget).toString("utf8").replace(/\uFFFD$/, "");
          value.truncated = true;
          if (key === "displayOutput") value.displayTruncated = true;
        }
      }
    }
  }
  const json = JSON.stringify(value);
  // The preview is JSON encoded again; leave room for escaping quotes and backslashes.
  const details = Buffer.byteLength(json) <= 64 * 1024 ? value : {
    ok: value.ok, code: value.code, hostId: value.hostId,
    outcome: value.outcome, exitCode: value.exitCode, timedOut: value.timedOut,
    cancelled: value.cancelled, elevated: value.elevated,
    fullOutputPath: value.fullOutputPath, outputLogError: value.outputLogError,
    truncated: true, preview: Buffer.from(json).subarray(0, 24 * 1024).toString("utf8"),
    note: "Output truncated. Request fewer entries or a smaller line range. Never replay an unknown command outcome.",
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, isError: value.ok === false };
}

export function registerTools(pi: ExtensionAPI, environment: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<ToolEnvironment>, native: NativeRenderers) {
  for (const name of Object.keys(schemas) as ToolName[]) {
    const { $schema: _schema, ...parameters } = z.toJSONSchema(schemas[name], { target: "draft-7", io: "input" });
    const tool: ToolDefinition<TSchema> = {
      name, label: name, description: descriptions[name], parameters: parameters as TSchema,
      ...sshRenderers(name, native),
      annotations: { readOnlyHint: READ_ONLY.has(name), destructiveHint: !READ_ONLY.has(name), openWorldHint: true, idempotentHint: false },
      async execute(_id, input, signal, onUpdate, ctx) {
        let view: Record<string, unknown> = {};
        const report = (value: Record<string, unknown>) => {
          view = { ...view, ...value };
          try { void Promise.resolve(onUpdate?.(toolResult({ ...view, running: true }))).catch(() => {}); } catch { /* Rendering must not change execution. */ }
        };
        report({});
        try {
          const env = { ...await environment(ctx, signal) };
          env.report = report;
          env.progress = (bytes, total) => report({ bytes, total });
          const result = await executeTool(name, input, env);
          return toolResult({ ...view, ...result });
        } catch (error) { return toolResult({ ...view, ...failure(error) }); }
      },
    };
    pi.registerTool(tool);
  }
}
