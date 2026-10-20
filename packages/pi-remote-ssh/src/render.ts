import { Container, Text } from "@earendil-works/pi-tui";
import type { ToolRenderers, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolName } from "./tools.ts";
import { stripVTControlCharacters } from "node:util";

export type NativeRenderers = Required<Pick<ReturnType<typeof createBashToolDefinition>, "renderCall" | "renderResult">>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
// No remote terminal controls or OSC hyperlinks are allowed into a tool row.
const clean = (value: string) => stripVTControlCharacters(value).replace(/\r/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
const oneLine = (value: unknown) => clean(text(value)).replace(/\n/g, " ");

function resultText(name: ToolName, data: Record<string, unknown>, partial: boolean, fallback: string) {
  let output: string;
  if (name === "ssh_shell_exec") {
    output = text(data.displayOutput) || text(data.stdout) + text(data.stderr);
    if (!partial && !data.error && !["displayOutput", "stdout", "stderr"].some(key => Object.hasOwn(data, key))) output = fallback;
    if (!partial) {
      const messages: string[] = [];
      if (data.timedOut) messages.push("Command timed out. Remote termination is not guaranteed.");
      if (data.cancelled) messages.push("Command cancelled. Remote termination is not guaranteed.");
      if (typeof data.exitCode === "number" && data.exitCode !== 0) messages.push(`Command exited with code ${data.exitCode}`);
      if (data.outcome === "unknown") messages.push("Remote outcome unknown; never replay automatically.");
      else if (data.exitCode === null) messages.push("Remote exit code unavailable.");
      if (data.signal) messages.push(`Remote signal: ${oneLine(data.signal)}`);
      if (data.error) messages.push(text(data.error));
      output = [output || (messages.length ? "" : "(no output)"), ...messages].filter(Boolean).join("\n\n");
    }
  } else if (data.error) output = text(data.error);
  else if (name === "ssh_list_hosts" && Array.isArray(data.hosts)) {
    output = data.hosts.map(item => {
      const host = record(item);
      return `${oneLine(host.name)} [${oneLine(host.id)}] — ${oneLine(host.username)}@${oneLine(host.hostname)} | ${oneLine(host.directory) || "~"}`;
    }).join("\n") || "No SSH hosts configured.";
  } else if (typeof data.content === "string") output = data.content || "(empty file)";
  else if (Array.isArray(data.matches)) output = data.matches.map(value => typeof value === "string" ? value : JSON.stringify(value)).join("\n") || "No matches.";
  else if (Array.isArray(data.files)) output = data.files.map(value => String(value)).join("\n") || "No matching files.";
  else if (typeof data.bytes === "number") output = `${partial ? "Transferring" : "Transferred"}: ${data.bytes}${typeof data.total === "number" ? ` / ${data.total}` : ""} bytes${data.path ? `\n${text(data.path)}` : ""}`;
  else if (name === "ssh_write_file" && data.ok) output = `Wrote ${text(data.path)}`;
  else if (name === "ssh_reset_connection" && data.ok) output = `Connection reset.\nWorking directory: ${text(data.directory)}`;
  else if (data.directory && data.ok) output = `Working directory: ${text(data.directory)}`;
  else output = partial ? "" : fallback || (data.ok ? "Done." : "No result details available.");
  if (data.truncated && !data.fullOutputPath && !data.displayTruncated) output += "\n\nOutput truncated; request a smaller range.";
  if (data.displayTruncated) output += "\n\nOutput truncated: showing the retained tail.";
  if (data.outputLogError) output += `\n\n${text(data.outputLogError)}`;
  return clean(output);
}

/** Reuse public native bash callbacks, not private renderer/timer modules or a second shell. */
export function sshRenderers(name: ToolName, native: NativeRenderers): ToolRenderers {
  return {
    renderCall(args, theme, context) {
      const input = record(args);
      const target = () => oneLine(context.state.sshHostName) || oneLine(input.hostId) || "hosts";
      const shellArgs = { command: name === "ssh_shell_exec" ? clean(text(input.command)) : "",
        timeout: name === "ssh_shell_exec" ? (typeof input.timeoutMs === "number" ? input.timeoutMs / 1000 : 120) : undefined };
      const call = native.renderCall(shellArgs, theme, { ...context, args: shellArgs, lastComponent: undefined, executionStarted: context.executionStarted && context.isPartial });
      const container = new Container();
      const header = (value: () => string) => ({ render: (width: number) => new Text(value(), 0, 0).render(width), invalidate() {} });
      if (name === "ssh_shell_exec") {
        container.addChild(header(() => theme.fg("toolTitle", theme.bold(`SSH · ${target()}${input.sudo === true ? " · sudo" : ""}`))));
        container.addChild(call);
      } else {
        const subject = name === "ssh_upload_file" ? `${oneLine(input.localPath)} → ${oneLine(input.remotePath)}`
          : name === "ssh_download_file" ? `${oneLine(input.remotePath)} → ${oneLine(input.localPath)}`
          : [oneLine(input.path), oneLine(input.pattern)].filter(Boolean).join(" · ");
        container.addChild(header(() => theme.fg("toolTitle", theme.bold(`${name} · ${target()}`)) + (subject ? `\n${theme.fg("muted", subject)}` : "")));
      }
      return container;
    },
    renderResult(result, options, theme, context) {
      const data = record(result.details);
      if (typeof data.hostName === "string") context.state.sshHostName = data.hostName;
      const fallback = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      const output = resultText(name, data, options.isPartial, fallback);
      return native.renderResult({ content: [{ type: "text", text: output }], details: {
        fullOutputPath: typeof data.fullOutputPath === "string" ? clean(data.fullOutputPath) : undefined,
      } }, options, theme, { ...context, args: { command: text(record(context.args).command) } });
    },
  };
}
