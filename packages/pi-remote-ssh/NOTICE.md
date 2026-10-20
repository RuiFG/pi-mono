# Source provenance

The SSH transport, SFTP operations, host profiles, path handling, sudo protocol, and runtime were adapted from the owner's [opencode-remote-ssh](https://github.com/VibeCodingStudio/opencode-remote-ssh) project at commit `fdd338af0f7f76e1185ce049bca7d7fd0c06a853`, at the owner's request.

The referenced source snapshot declared `UNLICENSED`. With the project owner's authorization, this package is distributed under the [MIT License](./LICENSE). This notice does not change the source project's license.

Pi integration, interactive menus, and encrypted-file credential storage are implemented in this package. No OpenCode or OpenTUI runtime dependency is included.

## Credential dialog layout

The credential dialog layout in `src/password.ts` follows the single-question view in [rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) at commit `d3c6f0812140605a4e55e0a660eb83edc12abbc5`: full-width accent borders, a header badge, numbered options, an inline editable row, and footer hints. Its renderer has been adapted for local masked credentials; the questionnaire tool, answer channel, and transcript integration are not included. The upstream package is not a runtime dependency.

Upstream license notice:

```text
MIT License

Copyright (c) 2026 juicesharp

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
