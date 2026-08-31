# Changelog

Both packages version together. See [CONTRIBUTING.md](CONTRIBUTING.md#releasing).

## 0.2.0 — 2026-08-31

The agent could see what the twin received. It can now also ask what the twin
*is*, and manage its lifecycle — without either package growing a tool surface
that a second engine integration would have to grow again.

- **The Veris MCP server is registered automatically** (`@veris-ai/daytona-opencode`).
  Twin lifecycle — read the environment, promote a sandbox to the environment's
  baseline, reset it — comes from Veris's own MCP rather than from tools
  reimplemented here, so it stays one codebase across every engine. It uses the
  `VERIS_API_KEY` already required, and registers nothing when that is unset:
  a server wired with an empty credential fails every call and reads as a Veris
  outage rather than a missing setting. Everything is `??=`, so a user's own
  `opencode.json` wins and an existing `opencode-veris-sim` install does not
  double-register.
- **`create_sandbox` and `delete_sandbox` are denied by default**, with
  `promote_sandbox` and `reset_sandbox` set to ask. The plugin creates and owns
  the session's twin, which makes the first two always wrong: a second twin takes
  neither the traffic nor the receipts with it, so an agent would seed it and
  report success while nothing changed — the exact failure the receipt exists to
  catch, one layer up.
- **New tool `verisTwin`** reports the twin's id and the services it answers for,
  and with a service argument returns that service's manual. The id is the piece
  no MCP server can supply: the session→sandbox→twin mapping lives in the
  plugin's session manager, which is also why the receipt is a tool rather than
  an MCP call.
- **New `sbx.veris.manual(service)`** on `@veris-ai/daytona`, alongside a new
  `twin-state` error phase. Like `receipt()`, it reads the twin's control plane
  from the host — `control_url` stays off the sandbox's allowlist, because code
  that could reach `/veris/reset` could erase its own receipt.
- The system prompt now states that the plugin owns the twin's lifecycle and
  that nothing here runs under `veris-proxy`. This matters when
  `opencode-veris-sim` is also installed: its commands describe a
  laptop-plus-proxy setup, and saying the premise is false is cheaper than
  suppressing them.

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
