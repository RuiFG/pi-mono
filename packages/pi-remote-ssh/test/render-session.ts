import { SessionManager } from "@earendil-works/pi-coding-agent";
import path from "node:path";

// Synthetic, offline transcript used only by the native terminal test.
const directory = process.argv[2];
if (!directory) throw new Error("Expected an isolated fixture directory");
const session = SessionManager.create(directory, path.join(directory, "sessions"));
session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "ssh-render-fixture", name: "ssh_shell_exec", arguments: {
  hostId: "00000000-0000-4000-8000-000000000001", command: "printf fixture", timeoutMs: 45000,
} }], api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: Date.now(),
usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const displayOutput = Array.from({ length: 20 }, (_, i) => `RENDER_FIXTURE_${String(i).padStart(2, "0")}`).join("\n");
session.appendMessage({ role: "toolResult", toolCallId: "ssh-render-fixture", toolName: "ssh_shell_exec",
  content: [{ type: "text", text: JSON.stringify({ stdout: displayOutput, exitCode: 7 }) }],
  details: { displayOutput, stdout: displayOutput, stderr: "", exitCode: 7, outcome: "exited", hostName: "render-fixture" },
  isError: true, durationMs: 4200, timestamp: Date.now() });
console.log(session.getSessionFile());
