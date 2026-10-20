# pi-remote-ssh

Multi-host SSH and SFTP tools for [Pi](https://pi.dev), with an interactive `/ssh` host manager. All plugin commands, prompts, descriptions, and errors are in English. There is no sidebar or persistent widget.

## Requirements

- Node.js 22.19 or newer. Pi 1.3.0 is the development and validation baseline.
- Windows, macOS, or Linux/WSL on the local machine; a Linux SSH server remotely.
- A usable SFTP subsystem for file operations. Shell execution remains available when SFTP is unavailable.
- Standard password or private-key authentication; encrypted private keys and nested jump hosts are supported. OTP, browser login, and menu-driven bastions are not supported.
- The server's existing `sh`, `grep`, and optional `sudo`. No remote helper is installed.

The package is currently private and has not been published to npm. Its license is `UNLICENSED` pending a separate licensing decision. See [NOTICE.md](./NOTICE.md) for source provenance.

## Local installation

From the repository root:

```sh
npm ci
pi install ./packages/pi-remote-ssh
```

This adds a user-level local-path package. Pi loads the TypeScript entry directly; no build step is required. Keep the checkout in place. Pi does not install dependencies for local-path packages, so run `npm ci` first.

To try it for a single invocation instead:

```sh
pi -e ./packages/pi-remote-ssh
```

Restart Pi after installation, or use its resource reload command. No credentials or host configuration are imported from other applications.

## Host management

Run `/ssh` without arguments in the interactive Pi terminal:

1. Choose **Add host**.
2. Enter a unique name, address, port, and username.
3. Choose **Password** or **Private key**. Key paths are local paths.
4. Choose an optional jump host. Save jump hosts first; each jump can reference another jump, up to 16 hosts in a route. Cycles are rejected.
5. Optionally set a login credential now, or enter it when connecting.
6. Select a host to connect, test SSH/SFTP, disconnect, edit, authorize, manage credentials, reset trust, or delete it.

The menu lists each host's state and working directory. Connection tests use a temporary connection and do not change the session's directory. Connection settings take effect after reconnecting; renaming preserves the stable host ID. Changing the login endpoint discards the old login credential reference so it is not sent to a different server.

Use **Set login credential** to replace a password or passphrase. Password fields are masked and support typing, paste, Unicode backspace, Enter, Esc, and Ctrl+U. Never enter secrets into the conversation, `/ssh` arguments, tool parameters, or shell command text.

## Authorization

Before the first shell command, remote file mutation, transfer, or connection reset on a host, the plugin asks for authorization for that host in the current session. The confirmation includes the login identity and jump route. This grant includes destructive remote actions; it is not restricted to one directory.

- `sudo: true` requires separate approval for **each command**, including NOPASSWD sudo.
- Uploads and downloads require separate confirmation of the local path and transfer direction for **each call**. Local paths are canonicalized before confirmation.
- Read and search tools can connect without a mutation grant; connection does not imply mutation authorization.
- Grants are memory-only, bound to the host's connection identity and route, and are not copied into a fork or another process.
- Use **Revoke session permissions** to revoke grants. Session replacement, tree navigation, reload, and shutdown also clear them. Revocation does not undo or terminate an operation that has already started.
- Without an interactive approval channel and an existing grant, mutations fail closed. Masked credential entry requires the terminal UI; it is not forwarded through ordinary RPC text input.

Pi's tool annotations describe read-only and destructive operations for other extensions. They are not an OpenCode-style Plan/Explore policy or a security sandbox. This plugin does not infer an agent's role from its name, and it does not replace local Pi tools. A remote shell command can perform any action permitted by the remote account after authorization. The separate sudo confirmation applies to the structured `sudo: true` option; it cannot prevent escalation embedded inside arbitrary shell code. Enforce privilege restrictions on the server if that is required.

## Tools

Start with `ssh_list_hosts` to obtain stable IDs. Every other tool requires `hostId`; names and implicit default hosts are rejected.

| Tool | Parameters besides `hostId` |
| --- | --- |
| `ssh_list_hosts` | No parameters; returns IDs, names, status, and session directories without credentials |
| `ssh_set_workspace` | `path?` |
| `ssh_shell_exec` | `command`, `sudo?`, `stdin?`, `timeoutMs?` |
| `ssh_list_directory` | `path?`, `limit?` |
| `ssh_read_file` | `path`, `startLine?`, `limit?` |
| `ssh_write_file` | `path`, `content`, `overwrite?` |
| `ssh_grep` | `pattern`, `path?`, `include?`, `ignoreCase?`, `limit?` |
| `ssh_glob` | `pattern`, `path?`, `limit?` |
| `ssh_mkdir` | `path`, `parents?` |
| `ssh_delete` | `path`, `recursive?` |
| `ssh_move` | `source`, `destination`, `overwrite?` |
| `ssh_upload_file` | `localPath`, `remotePath`, `overwrite?` |
| `ssh_download_file` | `remotePath`, `localPath`, `overwrite?` |
| `ssh_reset_connection` | No additional parameters |

Example requests:

```text
List my SSH hosts, then inspect /srv/app on the development server.
Check the logs on development and staging independently.
Upload ./build/app.zip to /tmp/app.zip on development.
Download /var/log/app.log from staging to ./logs/app.log.
```

### Paths and files

Each host has a separate working directory in the current Pi session. The first connection starts at the login user's home directory. `ssh_set_workspace` validates a directory before changing it; a temporary `cd` inside a shell command does not change the stored directory.

Remote paths follow Linux rules. `~` and `~/` expand to the remote home; `~other-user` is not supported. Local relative paths resolve against Pi's working directory. Transfer destinations are exact file paths, not containing directories.

- Existing destinations require explicit `overwrite: true`.
- Nonempty directory deletion requires `recursive: true`; recursive deletion does not follow directory symlinks.
- Missing directory ancestors require `parents: true` with `ssh_mkdir`.
- Write/upload/move/download parent directories must exist.
- Transfers stream one file at a time, including binary files. Archive directories before transferring them.
- Remote file replacement uses the OpenSSH atomic rename extension where available; it never deletes the original first to emulate replacement.
- Reads, searches, directory traversal, and tool output are bounded and report truncation. Request smaller ranges or fewer entries when output is truncated.

### Commands, sudo, and cancellation

Commands wait for a result, with a default timeout of 120 seconds. `timeoutMs: 0` disables the command timeout. Timeout and cancellation attempt to terminate the foreground command. Detached remote processes may continue.

Results distinguish `outcome: "exited"` from `outcome: "unknown"`. A lost connection or unconfirmed termination must **not** cause automatic replay. A nonzero exit status is a failed tool result.

With `sudo: true`, the entire command runs through `sudo -u root -- sh`, including redirection and pipelines. The server must allow a root shell. TTY-only sudo and OTP are not supported. The password is requested separately and is never part of command arguments or tool results. Command `stdin` is sent only after authentication succeeds. An incorrect password may be retried inside the same sudo authentication process; the command is never replayed for authentication.

Sudo credentials are separate from SSH credentials. The user may explicitly choose to copy the host's SSH password for sudo. **Clear sudo credential** removes the plugin's cached/remembered sudo credential, not the server's own sudo timestamp.

If a remembered sudo credential cannot be read or removed because the system vault is unavailable, the terminal asks **Use a temporary sudo credential?** before requesting a replacement. Accepting keeps the replacement in memory for this runtime only, bound to the same host and connection identity; it does not overwrite the saved credential reference. Declining, cancelling, or running without the terminal fails closed. Once the vault is usable again, choose **Clear sudo credential** to remove the old stored credential. Clearing drops the runtime replacement even if deleting the stored credential still fails, and reports that failure rather than claiming successful deletion. Vault cleanup failures do not replace command outcomes or cancellation errors.

## State and credentials

Default data directory:

```text
~/.local/share/pi-remote-ssh/
  hosts.json
  known-hosts.json
  sudo-credentials.json
  credentials/           # Windows DPAPI ciphertext only
```

`PI_REMOTE_SSH_DATA_DIR` overrides the directory. Otherwise `XDG_DATA_HOME` is respected. JSON files contain host data and credential references, never passwords or passphrases. Writes are atomic; profile and trust updates use file locks to avoid lost updates between processes. Other processes reload profiles before tool operations. Active-use checks are local to each runtime, not a cross-process connection registry.

Remembering a credential is opt-in:

- **Windows:** user-scoped DPAPI via system Windows PowerShell. Secret bytes travel over stdin, not command-line arguments or environment variables.
- **macOS:** system Keychain through the optional `@napi-rs/keyring` binding.
- **Linux/WSL:** Secret Service through the same optional binding. There is no fallback to a nonpersistent kernel keyring. Headless WSL installations may have no usable credential store.

When a vault is unavailable or locked, saving fails visibly. The user can explicitly choose temporary memory-only use instead; the plugin never falls back to plaintext. Temporary credentials are cleared when this extension runtime ends, including reload or session replacement. Private-key files remain at their original local paths.

Server fingerprints use **trust on first use (accept-new)** for each endpoint and jump. The first key is recorded automatically; later mismatches fail. This does not authenticate the first connection against a trusted external fingerprint. Verify identity out of band before resetting a trust record.

Connections and working directories are not persisted. A new Pi runtime/session starts disconnected at the remote home on first use. Independent subagent processes do **not** inherit connections, directory snapshots, temporary credentials, or approvals; explicitly set their host directories. This differs from the reference application's shared background-service model.

Manual disconnect prevents ordinary tools from reconnecting that host. Use **Connect** or `ssh_set_workspace` explicitly. Unexpected network loss permits a later operation to reconnect and revalidate the previous directory, but never replays the interrupted operation.

## Development and validation

From the repository root:

```sh
npm ci
npm run check --workspace pi-remote-ssh
npm run test:integration --workspace pi-remote-ssh
npm run test:package --workspace pi-remote-ssh
# Linux/macOS with Python 3 and a pseudo-terminal:
npm run test:native-tui --workspace pi-remote-ssh
```

- `check`: strict TypeScript checking plus unit, authorization, masking, storage, and schema tests. Docker integration is skipped unless explicitly enabled.
- `test:integration`: requires Docker; creates isolated Linux OpenSSH servers and jump hosts on loopback ports, then removes its containers/network/test image and temporary data. Includes real sudo authentication and wrong-password retry while a fixture vault rejects reads and deletes. No production host or model provider is used.
- `test:package`: packs into a temporary directory, installs only package runtime dependencies in an isolated consumer (without the optional vault binding), and validates loading through Pi's real extension loader and SDK. No model call is made.
- `test:sdk`: directly validates source loading, 14 tools, the host wizard, masked credential input, and denied execution through Pi's real SDK with scripted UI responses.
- `test:native-tui`: launches the real Pi CLI in an isolated Unix pseudo-terminal with no model credentials; exercises `/ssh`, the host wizard, and masked password entry, asserting plaintext never appears in terminal output or host configuration.

Linux/WSL validation does not prove Windows/macOS native UI or vault compatibility. Platform-specific tests must run on those platforms before claiming production support there.
