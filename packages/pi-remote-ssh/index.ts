import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RemoteRuntime } from "./src/runtime.ts";
import { dataDirectory } from "./src/paths.ts";
import { Permissions, display } from "./src/permissions.ts";
import { Dialogs, CredentialDialogs, hostMenu } from "./src/ui.ts";
import { registerTools } from "./src/tools.ts";
import { errorText } from "./src/domain.ts";

export default function remoteSsh(pi: ExtensionAPI) {
  let current: ExtensionContext | undefined;
  let instance: Promise<RemoteRuntime> | undefined;
  let loaded: RemoteRuntime | undefined;
  let credentials: CredentialDialogs | undefined;
  let dialogs = new Dialogs();
  const permissions = new Permissions();
  let sessionId: string | undefined;

  const runtime = () => instance ??= (async () => {
    const result = new RemoteRuntime(dataDirectory());
    await result.load();
    loaded = result;
    credentials = new CredentialDialogs(result, dialogs, () => current);
    return result;
  })().catch(error => { instance = undefined; throw error; });

  const environment = async (ctx: ExtensionContext, signal?: AbortSignal) => {
    current = ctx;
    const id = ctx.sessionManager.getSessionId();
    if (sessionId && sessionId !== id) { loaded?.release(sessionId); permissions.clear(); }
    sessionId = id;
    return { runtime: await runtime(), permissions, confirm: dialogs.confirm(ctx), sessionId: id, cwd: ctx.cwd, signal: dialogs.signal(signal) };
  };

  registerTools(pi, environment);
  pi.registerCommand("ssh", {
    description: "Manage SSH hosts, test connections, and configure login credentials",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/ssh requires the interactive Pi terminal UI", "error"); return; }
      if (args.trim()) { ctx.ui.notify("Use /ssh without arguments. Never put credentials in command arguments.", "warning"); return; }
      await ctx.waitForIdle();
      try {
        const env = await environment(ctx);
        await hostMenu(ctx, env.runtime, permissions, dialogs, env.sessionId);
      } catch (error) { ctx.ui.notify(display(errorText(error)), "error"); }
    },
  });
  pi.on("session_start", async (_event, ctx) => { await environment(ctx); });
  pi.on("session_tree", (_event, ctx) => {
    // Tree navigation is an authorization boundary; do not carry approvals into a different branch.
    if (sessionId) loaded?.release(sessionId);
    permissions.clear();
    current = ctx;
  });
  pi.on("session_shutdown", async () => {
    dialogs.close();
    credentials?.close();
    // An in-flight lazy load must also be closed, not leaked across reload/session replacement.
    try { (loaded ?? await instance)?.close(); } catch { /* Failed initialization owns no sockets. */ }
    permissions.clear();
    current = undefined; sessionId = undefined; loaded = undefined; instance = undefined; credentials = undefined;
    dialogs = new Dialogs();
  });
}
