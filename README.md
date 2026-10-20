# pi-mono

Pi extensions developed and maintained by RuiFG, with recommendations for third-party extensions.

## Status

First-party Pi extensions are developed as npm workspaces and installed individually.

- `packages/` contains first-party packages.
- Third-party extensions are documented here and installed separately through Pi.
- No installer, preset manager, automatic updater, or external service deployment is included.
- The root package is private and is not published to npm.

## Repository structure

```text
pi-mono/
├── packages/
│   ├── pi-remote-ssh/     # SSH tools and host management
│   └── README.md          # Package development guidelines
├── .gitignore
├── package.json           # Private npm workspace root
├── package-lock.json
└── README.md
```

## Packages

| Package | Purpose | Install |
| --- | --- | --- |
| [pi-remote-ssh](./packages/pi-remote-ssh/README.md) | Multi-host SSH/SFTP tools, session authorization, and an interactive `/ssh` menu | `pi install npm:pi-remote-ssh` |

See [package development guidelines](./packages/README.md).

### Local development

Use Node.js 22.19 or newer and npm. See each package's README for its Pi compatibility baseline.

```bash
git clone https://github.com/RuiFG/pi-mono.git
cd pi-mono
npm ci
```

`npm ci` installs workspace runtime and development dependencies; it does not register extensions in your personal Pi configuration or install the third-party recommendations below.

```sh
npm run check
```

Package-specific integration, installation, and validation instructions are in each package's README.

## Recommended extensions

These extensions are maintained by their respective upstream projects. They are optional recommendations, not dependencies of this repository. Install only what you need.

Review each project's documentation, Pi compatibility, and authentication requirements before installing. Extensions execute code; inclusion here is not a security audit or compatibility guarantee. Run the commands below in a terminal to install into your user-level Pi environment.

### Extensions with verified npm sources

| Extension | Purpose | Install |
| --- | --- | --- |
| [@juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | Structured questions with selectable answers | `pi install npm:@juicesharp/rpiv-ask-user-question` |
| [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | Task lists and progress tracking | `pi install npm:@juicesharp/rpiv-todo` |
| [pi-codex-image-gen](https://github.com/jvm/pi-mono/tree/main/packages/pi-codex-image-gen) | Image generation and editing; requires authentication as documented upstream | `pi install npm:pi-codex-image-gen` |
| [pi-lens](https://github.com/apmantza/pi-lens) | LSP integration, code navigation, and diagnostics; see upstream for language tooling requirements | `pi install npm:pi-lens` |
| [pi-live-models](https://github.com/wait4xx/pi-live-models) | Live model discovery and catalog overrides; requires provider configuration | `pi install npm:pi-live-models` |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | Subagent delegation and workflows; requires usable model configuration | `pi install npm:pi-subagents` |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | Web search and content retrieval; see upstream for provider authentication requirements | `pi install npm:pi-web-access` |

Package names, repository metadata, and Pi resource declarations have been checked against npm. Installation and combined compatibility have not been tested in this repository. These commands do not pin versions: npm's upstream `latest` tag determines the version installed. This does not enable automatic updates at Pi startup or guarantee compatibility between all latest releases.

The npm packages for `pi-lens` and `pi-web-access` already declare their `dist` resource entry points. Do not append `:dist` to their package names.

### Integrations awaiting distribution details

| Integration | Purpose | Notes |
| --- | --- | --- |
| OpenViking integration | Persistent context and memory | The public source and installation entry point for the Pi extension still need verification. Do not assume the server project or a similarly named package is the Pi extension. A service instance and access configuration are required. |
| `orca-agent-status.ts` | Orca agent status integration | The upstream source, distribution method, and host requirements for this single-file extension still need verification. No installation command is provided yet. |

These entries are recommendations only. Local extension files, service addresses, and credentials are not included in this repository.

### Managing installed extensions

```bash
pi list
pi config
```

Use `pi list` to inspect configured packages and `pi config` to manage enabled resources. A configured or installed package is not proof of successful loading, service connectivity, or authentication. Follow the upstream instructions to verify each integration.

Use your Pi version's native commands to update or remove extensions. Check `pi update --help` before updating; do not assume that bare `pi update` updates only extensions. This repository does not modify or manage your personal Pi configuration.

## Releases

Maintainers can publish `pi-remote-ssh` by pushing a matching `pi-remote-ssh-v<version>` tag. GitHub Actions validates and packs the package, publishes it through npm OIDC trusted publishing, and creates a GitHub Release. Ordinary pushes to `main` do not publish. See the [release setup and recovery guide](./docs/releases.md), including the required npm trusted-publisher setup.

## Licensing and publishing

Licenses are specified per package. [pi-remote-ssh](./packages/pi-remote-ssh/README.md) is licensed under the [MIT License](./packages/pi-remote-ssh/LICENSE). Before publishing another functional package, specify its license, package name, and published files; public visibility alone does not grant an open-source license. Third-party extensions remain subject to their upstream licenses.
