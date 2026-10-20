import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { temporary } from "./helpers.ts";

export async function smoke(extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url))) {
  const temp = await temporary();
  const previous = process.env.PI_REMOTE_SSH_DATA_DIR;
  process.env.PI_REMOTE_SSH_DATA_DIR = path.join(temp.directory, "ssh-data");
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: temp.directory, agentDir: path.join(temp.directory, "agent"), settingsManager,
    additionalExtensionPaths: [extensionPath], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(temp.directory, "auth.json"), modelsPath: null, modelsStorePath: path.join(temp.directory, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
    ({ session } = await createAgentSession({ cwd: temp.directory, agentDir: path.join(temp.directory, "agent"), settingsManager, resourceLoader, modelRuntime, sessionManager: SessionManager.inMemory(temp.directory) }));
    const errors: string[] = [];
    const select = ["Add host", "Password", "None", "Close"];
    const input = ["Smoke host", "example.test", "22", "tester"];
    const notifications: string[] = [];
    // Saving must work even in an isolated installation with no OS credential service or binding.
    const confirmations = [true, true];
    const confirmationTitles: string[] = [];
    const secret = "sdk-fixture-secret";
    const ui = {
      select: async (title: string, choices: string[]) => { const answer = select.shift(); assert.ok(answer && choices.includes(answer), `${title}: unexpected choice ${answer}`); return answer; },
      input: async () => input.shift(), confirm: async (title: string) => { confirmationTitles.push(title); return confirmations.shift() ?? false; },
      custom: async (factory: (tui: { requestRender(): void }, theme: unknown, keys: unknown, done: (value: string | undefined) => void) => { handleInput(data: string): void; render(width: number): string[]; dispose(): void }) => {
        let value: string | undefined;
        const component = factory({ requestRender() {} }, undefined, undefined, result => { value = result; });
        component.handleInput(secret);
        assert.ok(!component.render(80).join("\n").includes(secret));
        component.handleInput("\r"); component.dispose();
        return value;
      },
      notify: (message: string) => notifications.push(message),
    } as unknown as ExtensionUIContext;
    await session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => errors.push(error.error) });
    assert.deepEqual(session.getActiveToolNames().filter(n => n.startsWith("ssh_")).sort(), [
      "ssh_list_hosts", "ssh_set_workspace", "ssh_shell_exec", "ssh_read_file", "ssh_write_file",
      "ssh_grep", "ssh_glob", "ssh_upload_file", "ssh_download_file", "ssh_reset_connection",
    ].sort());
    await session.prompt("/ssh");
    assert.equal(select.length, 0); assert.equal(input.length, 0); assert.equal(confirmations.length, 0);
    assert.ok(notifications.includes("Host saved"));
    assert.deepEqual(confirmationTitles, ["Set login credential now?", "Remember credential?"]);
    const tools = session.agent.state.tools;
    const listed = await tools.find(tool => tool.name === "ssh_list_hosts")!.execute("list", {}, undefined);
    assert.ok(JSON.stringify(listed).includes("Smoke host"));
    assert.ok(!JSON.stringify(listed).includes("credentialId"));
    assert.ok(!JSON.stringify(listed).includes(secret));
    assert.ok(!(await readFile(path.join(temp.directory, "ssh-data", "hosts.json"), "utf8")).includes(secret));
    const profiles = JSON.parse(await readFile(path.join(temp.directory, "ssh-data", "hosts.json"), "utf8")) as { id: string; credentialId: string; remembered: boolean }[];
    assert.equal(profiles[0].remembered, true);
    const directory = path.join(temp.directory, "ssh-data", "credentials");
    assert.ok(!(await readFile(path.join(directory, "vault.json"), "utf8")).includes(secret));
    const { EncryptedFileSecrets } = await import(pathToFileURL(path.join(path.dirname(extensionPath), "src/credentials.ts")).href);
    assert.equal(await new EncryptedFileSecrets(directory).get(profiles[0].credentialId), secret);
    // Cancel before connecting: the smoke test must never contact the fixture hostname.
    const controller = new AbortController(); controller.abort();
    const rejected = await tools.find(tool => tool.name === "ssh_shell_exec")!.execute("cancel", { hostId: profiles[0].id, command: "id" }, controller.signal);
    assert.equal(rejected.isError, true);
    assert.ok(JSON.stringify(rejected).includes("CANCELLED"));
    assert.deepEqual(confirmationTitles, ["Set login credential now?", "Remember credential?"]);
    assert.deepEqual(errors, []);
    assert.equal(session.messages.length, 0, "Host configuration and credentials must not enter the conversation");
    console.log("PASS: real Pi loader, 10 tools, /ssh wizard, encrypted credential persistence without OS vault or fallback, cancelled execution, no model requests");
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    if (previous === undefined) delete process.env.PI_REMOTE_SSH_DATA_DIR; else process.env.PI_REMOTE_SSH_DATA_DIR = previous;
    await temp.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await smoke(process.argv[2]);
