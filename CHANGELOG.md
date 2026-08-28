# Changelog

Both packages version together. See [CONTRIBUTING.md](CONTRIBUTING.md#releasing).

## 0.1.0 — unreleased

First release. Not yet published to npm.

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
