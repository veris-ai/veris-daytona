# Changelog

Both packages version together. See [CONTRIBUTING.md](CONTRIBUTING.md#releasing).

## Unreleased

- **Node now verifies vendor hosts in a fresh sandbox — for real this time.**
  0.2.1 pointed `NODE_EXTRA_CA_CERTS` at the merged bundle, and it made no
  difference: Daytona overwrites that variable (and `SSL_CERT_FILE`) inside
  the sandbox with its own CA file. That file is right for clients that go
  through Daytona's proxy, which terminates TLS with Daytona's CA. Node is not
  one of them — it ignores `HTTPS_PROXY`, is forwarded to the gateway end to
  end, and validates *our* leaf, which Daytona's CA cannot sign for. Every
  `node` vendor call failed, and agents kept prepending
  `NODE_EXTRA_CA_CERTS=/tmp/veris-ca-bundle.crt` because it was the only
  thing that worked. Since no variable we send survives, Node is switched to
  a store we can reach: `NODE_OPTIONS` carries `--use-openssl-ca`, so Node
  reads OpenSSL's store — `SSL_CERT_FILE` plus the system certificate
  directory, where the store install puts the Veris CA and the distribution
  keeps the public roots. A caller's own `NODE_OPTIONS` are kept, flag
  appended. As a second layer, the CA install appends the Veris CA to the
  file Daytona pointed `NODE_EXTRA_CA_CERTS` at (through `sudo -n`, the file
  being root-owned), and again after every `start()`. Verified live on
  Daytona's default image: plain `node` returns 200 with the flag and the
  Veris CA in `/etc/ssl/certs`, and `UNABLE_TO_VERIFY_LEAF_SIGNATURE` without
  the flag.
- **The system prompt says TLS trust is preconfigured** and tells the agent
  not to prefix commands, pass `--cacert`, or disable verification. Landed in
  #20 ahead of the fix above; it is only true with it.
- **`veris-daytona run`: the SDK as one command.** `npx @veris-ai/daytona run
  --setup 'npm ci' -- npm test` uploads the current directory (or clones
  `--repo`) into a sandbox whose vendor calls go to a twin, runs the command
  with its output streamed, prints the receipt, and deletes both. A passing
  command whose twin received nothing exits 1. Before this the package could
  only be used from code, so every repository needed its own script before an
  agent or a CI job could run its suite against a twin.

## 0.2.1 — 2026-09-01

- **`NODE_EXTRA_CA_CERTS` now points at the merged bundle, not the lone Veris
  cert.** That variable extends Node's *baked-in Mozilla roots*, never the
  system store — and the leaf Node actually validates in a Daytona sandbox is
  signed by Daytona's proxy CA, which lives only in the system store. So with
  the single-cert file, every Node HTTPS call to a vendor host failed with
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, and agents in the sandbox learned to
  compensate by prepending `NODE_EXTRA_CA_CERTS=/tmp/veris-ca-bundle.crt` to
  every command by hand. Every other trust variable already pointed at the
  bundle (system store — Daytona's CA with it — plus ours); Node's was the one
  exception, and now it isn't. Plain `node` works in a fresh sandbox, no flag,
  no prefix.

## 0.2.0 — 2026-08-31

Everything in `0.2.0-rc.1` below, promoted unchanged, plus two errors that named
a failure without naming its cause. Both were found the same way — by a user
losing an evening to a working setup that reported nothing useful.

- **`VerisError` now folds the wrapped error's message into its own.** `cause`
  was always attached, but almost nothing that shows an error to a human walks
  the cause chain: OpenCode prints `err.message` and stops. So an invalid
  Daytona API key surfaced as `Daytona sandbox create failed`, full stop, when
  the SDK had `DaytonaAuthenticationError: Invalid credentials` in hand the
  whole time. It now reads `Daytona sandbox create failed: Invalid credentials`.
  The cause stays reachable; a runaway message is truncated rather than pasted
  whole.
- **A 404 creating a twin now explains itself.** Environments belong to one
  control plane, so the usual cause of that 404 is an id from the *other* one —
  a prod `VERIS_ENVIRONMENT_ID` against a dev `VERIS_API_BASE`, or the reverse.
  The old message was `create sandbox in environment kl833…: 404`, which sends
  people to check their API key and their network first; both are fine, and
  neither is the problem. It now names the base it asked and says the two
  variables must agree.

## 0.2.0-rc.1 — 2026-08-31

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
