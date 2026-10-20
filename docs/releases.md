# Releasing pi-remote-ssh

The workflow `.github/workflows/publish-pi-remote-ssh.yml` publishes this package independently of other workspaces.

## One-time npm setup

In the **pi-remote-ssh** package settings on npmjs.com, add a **GitHub Actions** trusted publisher:

| Field | Value |
| --- | --- |
| Organization or user | `RuiFG` |
| Repository | `pi-mono` |
| Workflow filename | `publish-pi-remote-ssh.yml` |
| Environment name | Leave blank; the workflow does not use a GitHub deployment environment |
| Allowed actions | Enable direct publishing with **npm publish** |

Enter the workflow filename only, not `.github/workflows/…`. Field values are case-sensitive. Stage-only permission is not enough for automatic publication. Separate `npm dist-tag` permission is not needed by this workflow.

No `NPM_TOKEN`, npm password, or OTP belongs in the repository or GitHub Secrets. GitHub-hosted runners obtain short-lived OIDC credentials with `id-token: write`. npm currently requires Node.js 22.14+ and npm CLI 11.5.1+; the workflow uses Node.js 24 and checks the npm version before publishing.

**Timing:** npm currently requires the first successful trusted publish within **2 days** after creating a trusted publisher. Configure it when the next release is ready. If it expires, delete that configuration, recreate it, and complete the first publish within the new window. Saving the settings or passing a validation-only run does not validate OIDC publication.

See the authoritative [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) for current requirements. Once OIDC publication works, npm recommends the package publishing-access option **Require two-factor authentication and disallow tokens**. This still permits trusted publishing. Do not disable your account's 2FA.

## Release a version

A normal push to `main` does **not** publish a package. Publish by pushing a matching version tag. For example, when deliberately releasing `0.1.1`:

```sh
npm version 0.1.1 --workspace pi-remote-ssh --no-git-tag-version
# Update the pinned installation example in the package README and any release documentation.
npm run check
npm run test:integration --workspace pi-remote-ssh
npm run test:package --workspace pi-remote-ssh

git add packages/pi-remote-ssh/package.json packages/pi-remote-ssh/README.md package-lock.json
git commit -m "chore(pi-remote-ssh): release 0.1.1"
git push origin main

git tag -a pi-remote-ssh-v0.1.1 -m "pi-remote-ssh 0.1.1"
git push origin refs/tags/pi-remote-ssh-v0.1.1
```

Check the diff before committing and ensure the new version is not already published. Do not move or reuse published version tags. Consider protecting the `pi-remote-ssh-v*` tag pattern in repository rulesets so only release maintainers can create or change those tags.

## What the workflow does

1. Validates the package identity, public/MIT metadata, and agreement between the version tag and `package.json`.
2. Runs the release-helper tests, TypeScript/unit checks, Docker/OpenSSH integration tests, isolated package/SDK loading, and the native terminal smoke test on Linux.
3. Packs the tested source and checks its file list and integrity. Dependencies and test fixtures must not be bundled.
4. Passes that exact tarball through a workflow artifact to a separate npm publishing job. Dependency installation and tests do not receive OIDC publishing permission.
5. Publishes stable versions under `latest`, prereleases such as `0.2.0-beta.1` under `next`, and verifies the registry integrity.
6. Creates the matching GitHub Release with generated notes and attaches the same npm tarball. Prereleases are marked accordingly. Only this final job receives repository write permission; it does not receive OIDC publishing permission.

Actions are pinned to commit SHAs. Only tag runs in `RuiFG/pi-mono` can publish. Cancellation of a newer run does not interrupt an active release.

## Validation without publishing

Run **Publish pi-remote-ssh** from the GitHub Actions page and select the **main branch**, or use:

```sh
gh workflow run publish-pi-remote-ssh.yml --ref main --repo RuiFG/pi-mono
```

This runs tests and produces an artifact but skips npm publication and GitHub Release creation. A manual run on a matching **tag** is a real release, not a dry run.

Local helper validation:

```sh
npm run test:release
```

The Linux job does not establish native Windows/macOS vault or terminal compatibility. No workflow dry run can prove that the npm trusted publisher is correctly configured; the first real OIDC publish is the end-to-end check.

## Recovering a partial release

Rerun the failed tag workflow after correcting an infrastructure or authorization problem. A registry 404 permits publication; authentication and server errors do not. If npm already contains that version, its integrity must exactly match the workflow's tarball before the workflow skips publication and continues to the GitHub Release. Different content fails rather than replacing an immutable npm version.

If GitHub release creation or attachment fails after npm succeeds, the same workflow can finish it on a rerun. An existing release keeps its notes, and its package attachment is refreshed only after npm integrity has been verified.

The initial `0.1.0` was published manually before this workflow existed. Do not attempt to republish it to test OIDC. Tarball bytes can differ across packing environments even when source text matches, and the integrity guard intentionally rejects such differences for an existing version.
