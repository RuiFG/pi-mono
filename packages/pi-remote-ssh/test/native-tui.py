"""Unix-only native Pi terminal smoke test. No model calls or personal configuration."""

import fcntl
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

package = Path(__file__).resolve().parents[1]
cli = package.parents[1] / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
node = shutil.which("node")
assert node and cli.is_file(), "Run npm ci first"
with tempfile.TemporaryDirectory(prefix="pi-ssh-native-") as directory:
    master, slave = pty.openpty()
    _ = fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    env = {
        "PATH": os.environ["PATH"], "HOME": directory, "TERM": "xterm-256color",
        "LANG": "C.UTF-8", "PI_CODING_AGENT_DIR": directory + "/agent",
        "PI_REMOTE_SSH_DATA_DIR": directory + "/ssh", "PI_OFFLINE": "1",
        "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
    }
    process = subprocess.Popen(
        [node, str(cli), "--offline", "--no-extensions", "-e", str(package / "index.ts"),
         "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--no-session", "--tui-mode", "regular"],
        stdin=slave, stdout=slave, stderr=slave, cwd=directory, env=env, start_new_session=True,
    )
    os.close(slave)
    output = ""
    all_output = ""
    ansi = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")

    def wait_for(text: str, timeout: float = 20) -> None:
        global output, all_output
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if text in ansi.sub("", output):
                output = ""
                return
            if process.poll() is not None:
                raise AssertionError("Pi exited before " + text + "\n" + ansi.sub("", output)[-4000:])
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                data = os.read(master, 65536)
                decoded = data.decode("utf-8", errors="replace")
                output += decoded
                all_output += decoded
                # Answer the cursor-position probe used by terminal startup.
                if b"\x1b[6n" in data:
                    _ = os.write(master, b"\x1b[1;1R")
        raise AssertionError("Timed out waiting for " + text + "\n" + ansi.sub("", output)[-4000:])

    try:
        wait_for("No models available")
        _ = os.write(master, b"/ssh\r")
        wait_for("Remote SSH")
        _ = os.write(master, b"\r")
        wait_for("Host name")
        _ = os.write(master, b"native-test\r")
        wait_for("Hostname or IP address")
        _ = os.write(master, b"example.test\r")
        wait_for("SSH port")
        _ = os.write(master, b"22\r")
        wait_for("SSH username")
        _ = os.write(master, b"tester\r")
        wait_for("Authentication")
        _ = os.write(master, b"\r")
        wait_for("Jump host")
        _ = os.write(master, b"\r")
        wait_for("Set login credential now?")
        _ = os.write(master, b"\r")
        wait_for("SSH password for")
        _ = os.write(master, b"native-fixture-secret\r")
        wait_for("Remember credential?")
        # Escape declines persistent storage, keeping only this runtime's credential.
        _ = os.write(master, b"\x1b")
        wait_for("Remote SSH")
        _ = os.write(master, b"\x1b")
        hosts = Path(directory, "ssh", "hosts.json")
        assert hosts.is_file() and "native-test" in hosts.read_text()
        assert "native-fixture-secret" not in hosts.read_text()
        rendered = ansi.sub("", all_output)
        assert "native-fixture-secret" not in rendered
        assert "SSH CREDENTIAL" in rendered and "Private input" in rendered
        assert "Kept out of chat and model context." in rendered
        print("PASS: native Pi TUI /ssh, English host wizard, themed private credential card, no plaintext output, isolated configuration")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                _ = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                _ = process.wait(timeout=5)
        os.close(master)
