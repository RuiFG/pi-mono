# Remote SSH Host Management

Language for managing remote SSH hosts and their credentials.

## Language

**Host profile**:
A saved description of a remote SSH endpoint and the identity used to access it. A profile can exist without a live connection or a saved login credential.

**Connection status**:
The current condition of a connection to a host, distinct from the result of a particular management action.

**Connection test**:
An explicit, temporary check of a host's SSH connectivity and SFTP availability. It does not establish the working connection used for subsequent remote operations.

**Remote command outcome**:
What is known about a command's completion on the remote host. Losing a connection does not establish an exit code or prove that the remote process stopped.

**Command output preview**:
The bounded portion of command output retained for immediate inspection. Expanding a preview reveals retained text, not discarded output.

**Complete output log**:
A separate record of the filtered textual output received during a command. It excludes SSH/sudo authentication protocol data but may include sensitive information printed by the command itself.

**Host management step**:
An independently committed action, such as saving a host profile or setting its login credential. Cancelling an unfinished step does not undo an earlier completed step.
