# Changelog

Both packages version together. See [CONTRIBUTING.md](CONTRIBUTING.md#releasing).

## 0.1.1 — 2026-08-31

No functional change to either package. This is the release-pipeline release:
`0.1.0` was published by hand and carries no provenance attestation, and cutting
`0.1.1` through the workflow is the only way to prove the trusted-publishing
path — a dry run skips the publish entirely.

- The publish guard is per-package. It used to refuse the whole run if *either*
  package was already on npm, which made a partial release unrecoverable: if the
  SDK published and the plugin then failed, the retry aborted on the SDK it had
  just successfully published. It now skips what is published, publishes the
  rest, and fails only when there is nothing to do. The git tag and the GitHub
  release are idempotent for the same reason.
- Prereleases can be published. npm 11 refuses a prerelease without an explicit
  `--tag`, and the workflow passed none, so every `x.y.z-rc.n` would have failed
  at the publish step after the build, tests and pack had all passed. The
  dist-tag is now derived from the version (`0.2.0-rc.1` → `rc`) and can be
  overridden with the new `dist_tag` input.
- The workflow asserts its own provenance: a publish that lands without a
  `dist.attestations` now fails the run instead of shipping and looking fine.
- Tarballs are checked for a stray `node_modules` and against a 1 MB ceiling.
- `npm run release` is gone. The workflow is the only publish path.
- `version:set` refuses to write a `1.x` version while the plugin's dependency
  on the SDK is a caret range, which only pins a patch range below 1.0.0.
- Hardening: job-scoped workflow permissions, a `release` concurrency group,
  actions pinned by commit SHA, Dependabot, and Conventional Commits enforced on
  the PR title.

## 0.1.0 — 2026-08-31

First release.

### `@veris-ai/daytona`

- A drop-in for `@daytona/sdk`: re-exports the whole SDK and overrides only
  `Daytona`, so a single changed import puts a Veris twin behind every sandbox.
- `create()` provisions the twin, mints an egress credential, sets the
  `domainAllowList` and `outboundProxyUrl`, installs CA trust, and proves the
  tunnel with a canary probe before it resolves.
- `get()` and `list()` rehydrate the same surface from sandbox labels, so a
  resumed session keeps its receipts.
- `delete()` is wrapped to remove the twin, so nothing leaks.
- `sbx.veris`: `receipt()`, `assertTouched()`, `services()`,
  `getDataPlaneEnv()`, `getTrustEnv()`, `deliverTo()`.

### `@veris-ai/daytona-opencode`

- Fork of `@daytona/opencode` 0.192.0, four changed files: the SDK import, the
  tool registry, the system prompt, and a check that the Veris coordinates are
  set.
- Adds the `verisReceipt` tool.
