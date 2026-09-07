# Provider skills release validation

Checked 2026-09-07. Proposed SDK/plugin version: **0.3.0**, in lockstep via
`version:set`; plugin requires `^0.3.0` of its SDK. These are unreleased artifacts.
No package was published and no PR was merged.

## Baseline and dependencies

Current npm `latest` remains **0.2.1** for both packages. The downloaded
published SDK tarball has no `bin` and reads one default receipt page; the published
OpenCode receipt accepts only `service`, truncates display, and has no run selector.
Daytona main already had a CLI, ID pagination, watermarks and capped reporting;
this change retains that work and reviews its handling of malformed/short/stalled
pages. E2B stays SDK-only, matching [plugins #48](https://github.com/veris-ai/plugins/pull/48).

This branch stacks on [provider #31](https://github.com/veris-ai/veris-daytona/pull/31),
keeping that session's guidance work in its own PR. Native skills loading depends
on [plugins #49](https://github.com/veris-ai/plugins/pull/49): the current package
is **@veris-ai/veris-opencode 0.7.3**, not the earlier skills package name. Its
package entrypoint/config/resources were tested from the packed artifact at
reviewed revision `c65db268011225f87c49c56c117d10b0dbe9da9a`.

The canonical provider references in #49 still describe the published legacy
receipt tools. Before the provider feature release they need a capability-based
path for `verisTwin`, `verisReceipt(action=baseline)` followed by the returned
`baseline` token, and `verisControl`. Keep their older-release fallback and all
response/state evidence gates. No canonical skill files were edited or copied here.

## Passed locally

- Build and TypeScript checks for both packages; **224 SDK tests and 17
  plugin tests**. Focused cases cover more than 1,000 rows, smaller server caps,
  control/probe-only pages, lower bounds, malformed/failed reads, resets (including
  during paging), replaced sessions/services, token session binding, discovery,
  write denial and preserved explicit/scalar/wildcard user configuration.
- `npm run test:pack`: inspect and install both exact tarballs into a clean temp
  directory, with no workspace links. Verify public SDK import/version, compiled
  plugin tools, no bundled node_modules, and package size under the release limit.
- The packed CLI declares `veris-daytona`, includes executable `dist/cli.js`,
  and a clean installation runs `provision`, `push`, `exec`, and `teardown`
  `--help` successfully without provider credentials.
- `scripts/test-composition.mjs`, run with Bun against that clean installation
  plus the packed skills candidate: both plugin load orders, all three `/veris:*`
  commands, host-side canonical entrypoints/references/helper hashes, remote
  application-tool identity, and preservation of user MCP/skills/permissions.
- The skills adapter's own **8** artifact/config/resource tests also passed.

These are offline tests. Fake provider/HTTP boundaries exercise the SDK and tool
logic; they are not live application evidence.

## Reproduce artifact composition

After the normal `npm ci`, build, typecheck and unit tests:

```sh
npm run test:pack
# Use PACK_STAGE printed by that test and the reviewed skills release artifact:
npm install --prefix <PACK_STAGE> --ignore-scripts <reviewed-skills.tgz>
VERIS_PACK_STAGE=<PACK_STAGE> bun scripts/test-composition.mjs
```

This is a release artifact check, not an end-user installation fallback. End
users install published semantic versions as described in the README.

## Live acceptance remains pending

`DAYTONA_API_KEY`, `VERIS_API_KEY`, and `VERIS_ENVIRONMENT_ID` were unset.
No live provider was provisioned, no live `/veris:setup`/application/fault test was
run, and no cloud-to-host synchronization was verified. In particular, the deployed
trace must retain `x-veris-receipt-baseline` on control rows; baseline capture fails
explicitly if it cannot. Local source review confirms that shared trace contract,
but cannot establish what every deployed service currently runs.

With credentials, configure the skills package plus this one provider. Load
`/veris:setup`, use `verisTwin` to record provider/sandbox/twin/repository and source,
read a service manual/schema, seed/read back the required rows using `verisControl`,
then finish probes and capture a baseline. Execute a meaningful application test
that creates/reads a resource and asserts its response/state. Read the same baseline
and verify new matching IDs, completeness, mode/integrity and blind spots. Save
sanitized evidence in tracked files (or export ignored evidence explicitly), await
`gitSync`, and verify the host branch/commit and artifact. Setup must reuse the twin;
only the plugin owns final lifecycle teardown. Repeat separately for each provider.

## Release order

Land the prerequisite guidance and reviewed skills contract updates; release the
renamed skills package with its trusted-publisher configuration. Within this repo,
release **SDK 0.3.0 before plugin 0.3.0** through its existing workflow. Run live
acceptance before claiming the complete workflow is verified. Keep this PR draft
until those outstanding gates and dependencies are resolved.
