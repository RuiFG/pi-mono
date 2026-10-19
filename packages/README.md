# Packages

This directory contains packages developed and maintained in this repository. There are no functional packages yet; do not add placeholder extensions.

Third-party extensions are listed in the [root README](../README.md#recommended-extensions), not copied into this directory.

## Adding a package

Place each functional package in `packages/<directory>/` and include:

- `package.json` with its own name, version, description, and runtime dependencies. The directory name does not have to match the npm package name.
- `README.md` documenting its purpose, installation, configuration, prerequisites, and validation commands.
- The implementation and appropriate tests.
- A license and an explicit set of published files before release.

Pi extension packages should declare their resources through the `pi` field in `package.json`: extensions, skills, prompts, and themes. Declare only resources that exist. Configure `files` as needed so the published artifact includes those resources and all required runtime files.

Declare host-provided `@earendil-works/pi-*` packages and `typebox` as `peerDependencies` with a `"*"` range only when used, following the Pi documentation. Do not include them as runtime dependencies or bundle them into an extension. Each package declares its own actual runtime dependencies; recommending another extension does not make it a code dependency.

Packages are versioned, installed, and published independently. The root manages npm workspaces and does not expose a Pi resource entry point. Set `private: true` on packages that are not ready for publication.

## Development and validation

After adding a workspace, run `npm install` from the repository root and update the root `package-lock.json`. Do not maintain separate lockfiles inside individual packages.

Add build, type-checking, and test commands with each functional package, and document them in its README. Do not add empty tests or report a passing test suite for a skeleton. Before publishing, run the package's validation commands and `npm pack --dry-run --workspace <package-name>` to inspect the published files.

For local use, install dependencies and complete any required build steps before loading the package directory through Pi's local-path mechanism. Pi does not install dependencies for local-path packages, and npm workspace membership does not automatically enable an extension.

See [Pi Packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md). When implementing an extension, use the documentation shipped with the target Pi version.
