import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, ["--import", "tsx", "--test", fileURLToPath(new URL("./integration.test.ts", import.meta.url))], {
  env: { ...process.env, PI_REMOTE_SSH_INTEGRATION: "1" },
  stdio: "inherit",
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
