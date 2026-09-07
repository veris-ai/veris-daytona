# @veris-ai/daytona-opencode

An [OpenCode](https://opencode.ai) plugin. Every session runs in a
[Daytona](https://daytona.io) sandbox whose calls to `api.stripe.com` and the
rest of your vendor stack are answered by **Veris twins** — stateful,
contract-accurate fakes — and the agent gets a tool that shows what the vendor
actually received.

## Install

```jsonc
// opencode.json
{ "plugin": ["@veris-ai/daytona-opencode"] }
```

| variable | where from |
|---|---|
| `DAYTONA_API_KEY` | [app.daytona.io/dashboard/keys](https://app.daytona.io/dashboard/keys) |
| `VERIS_API_KEY` | [studio.veris.ai](https://studio.veris.ai) |
| `VERIS_ENVIRONMENT_ID` | a Veris environment — it decides which vendor services your twin gets |

Then `opencode`. No image to build, no network configuration, nothing to start.

## What the agent gets

Remote `bash`, `read`, `write`, `edit`, `multiedit`, `ls`, `glob`, `grep`,
`getPreviewURL`, and `gitSync`, plus the session tools below.

**`verisTwin`** returns JSON with `provider`, `sessionId`, execution `sandboxId`,
`twinId`, `environmentId`, `workingDirectory`, `lifecycleOwner`, `twinOwnership`,
service routes/control URLs and available capabilities. It lists services even
when the request log is empty. Pass `service` to read its manual. Verify remote
`pwd` and `git rev-parse HEAD`; a stored path does not prove source sync succeeded.

**`verisReceipt`** has two actions:

1. Finish seeding/probes and background work. Call `{"action":"baseline"}` before
   the isolated application test. Save the returned opaque `baseline` token.
2. Run and await that application command through `bash`, preserving TLS/network
   settings and recording its command, exit status and response/state assertions.
3. Call `{"action":"read","baseline":"<returned-token>","service":"stripe"}`.
   Omit `service` for all HTTP control services. Twin, sandbox and OpenCode session
   identity, interception mode, integrity and blind spots remain in every result.

Without a token the result is explicitly `scope: "cumulative"`, not current-run
proof. Baselines pin per-service request IDs and a unique read-only schema request
in the trace; reset, removed history, changed service coordinates or replacement
sessions invalidate them. A restart or eviction of an old token requires a new
baseline **before** rerunning the test. Services must retain control request headers;
an unsupported trace format fails baseline capture rather than pretending it is empty.

The SDK paginates up to 20 pages of 1,000 rows, within a newest-ID snapshot. It
filters control/reserved paths and explicitly marked probe tiers. A complete
zero means no application entries were observed in that window. Failed reads
throw; page budgets, stalled pagination and failures after partial progress set
`complete: false`, `countKind: "at-least"` and `incompleteReason`. Never subtract
two cumulative counts. The display includes at most 50 entries per service and
reports `omittedEntries`; this is separate from an incomplete underlying read.
Use `verisControl` requests with the returned `sinceId`/`untilId` window for raw
trace bodies, advancing `since_id` and filtering beyond `untilId` yourself.

An unmarked request to a vendor API made by a diagnostic probe looks like an
application call. Isolate the measurement; concurrent runs cannot be automatically
attributed. Bodies may be redacted/truncated and missing trace rows cannot be
recovered by the reader. Receipts remain observations, not tamper-proof execution
attestations; retain response/state assertions and reported blind spots.

**`verisControl`** provides host-side access to the attached service's `manual`,
`schema`, `operations`, `data` and `requests`. Pass `service` and `resource`;
`method` defaults to `GET`. Inspect schema/manual first, then read data with
`query: {"entity_type":"<table>","limit":"50","offset":"0"}`. Seed rows or
configure schema-defined faults with `POST`/`PATCH` `data` and
`body: {"data":{"<table>":[<rows>]}}`; read back the result. Raw data/request
responses are pages, not inferred totals. Service support is checked by its
response, and unsupported operations fail explicitly.

Writes request the `verisControlWrite` permission (default `ask`). User permissions,
including blanket/wildcard rules, win. The tool accepts no credentials, arbitrary
control URLs, reset, promotion, creation or deletion. The host resolves the service
from this session's twin, so neither credentials nor control endpoints need to be
guessed. File-byte transfer is outside this small control interface; a workflow
requiring it must use an available provider file interface or report the missing
capability. Canonical workflow content stays in `veris-ai/plugins`.

### The Veris MCP

The plugin also registers Veris's MCP server, so the agent can manage the twin's
lifecycle — read the environment, promote a sandbox to the environment's
baseline, reset it. Nothing to configure: it uses the `VERIS_API_KEY` you
already set, and is skipped entirely if that is unset.

Two of its tools are denied by default, because this plugin creates and owns the
session's twin. OpenCode does not merely refuse a denied tool when it is called
— it withholds it from the model, so the agent never learns the option exists:

| tool | default | why |
|---|---|---|
| `create_sandbox` | `deny` | makes a twin nothing else in the session uses — the agent would seed it and report success while traffic and receipts went elsewhere |
| `delete_sandbox` | `deny` | destroys the running session's twin |
| `promote_sandbox` | `ask` | rewrites what every future run in the environment starts from |
| `reset_sandbox` | `ask` | clears the request log the receipt is read from |

Set them yourself in `opencode.json` and your values win; the plugin only fills
in what you have not.

MCP calls run on your machine. Direct control-plane URLs may be blocked from the
sandbox, but that does not guarantee every `/veris/*` route is inaccessible through
an intercepted vendor hostname. Control-route reachability depends on the gateway.
Do not treat a receipt as a tamper-proof log or reset the twin to clear a baseline.

## Network interception

The sandbox is created with a `networkAllowList` holding only the Veris
gateway's address and an `outboundProxyUrl` pointing at that gateway. Daytona
forwards everything to the gateway, which answers vendor hostnames from the twin
and passes public hosts through; a process that bypasses the proxy is blocked.
`npm install` still works; `api.stripe.com` reaches your twin.

Everything above happens inside `@veris-ai/daytona`, which this plugin uses in
place of `@daytona/sdk`. See [its README](https://www.npmjs.com/package/@veris-ai/daytona)
if you want the same thing without an agent.

## Relationship to `@daytona/opencode`

This is a fork of `@daytona/opencode` 0.192.0 (Apache-2.0, Copyright Daytona
Platforms Inc.), and a deliberately small one: one changed import, three added
tools, a config hook, provider instructions in the system prompt, and a check that the
Veris coordinates are set. The ten inherited tools, the git-sync flow and the session
bookkeeping are untouched, so upstream changes stay easy to take.

## Adding Veris's skills alongside

Release prerequisites: this provider SDK/plugin pair **0.3.0**, and the first
published **@veris-ai/veris-opencode 0.7.3** from plugins PR #49. The composition
is tested using packed release candidates; these versions are not published by
this PR. Use the configuration after those npm releases exist. Resolve npm
versions once and pin the installed semantic versions for replay; do not use a
Git checkout/build installation fallback. PR #49's provider reference must also
reflect the new baseline/control capability contract before release.

The canonical workflows live in
[veris-ai/plugins](https://github.com/veris-ai/plugins/tree/main/veris).
[Plugins PR #49](https://github.com/veris-ai/plugins/pull/49) adds session-aware
loading and names the next skills package `@veris-ai/veris-opencode`, matching
`veris` in Claude and Codex. As checked on 2026-09-04, that name is not yet
published; the configuration below requires its first release:

```json
{
  "plugin": [
    "@veris-ai/daytona-opencode@latest",
    "@veris-ai/veris-opencode@latest"
  ]
}
```

Use `/veris:setup`, `/veris:build <request>` and `/veris:fix <request>`. The skills
verify and reuse this session's twin, load their installed references through a
host-side resource tool, and require evidence from the current application run.
They do not provision another sandbox or tear down this plugin's resources.
Finish by saving the evidence and awaiting `gitSync`; ignored files do not return
through git automatically. The skills adapter registers no MCP, so this provider's
existing server and user permissions remain in charge.

The published `@veris-ai/veris-sim-opencode` 0.7.0 package uses old commands and
host-file templates. After the new release, replace that entry in both global and
project configs where present, restart OpenCode, and record resolved versions.
Do not load both skills packages or manually skip old lifecycle instructions to
simulate the new workflow. Install only one sandbox provider plugin per session.

`verisTwin` still returns service manuals without the skills package.

## Synchronization and persistence

Initial sync sends committed host `HEAD` over Daytona SSH into
`/home/daytona/project`; uncommitted or later host edits are not imported.
`gitSync` commits remote changes and pulls them into the plugin-owned local
`opencode/N` branch. Verify its result and source commit; SSH host-key failures
can block either direction. Preserve verification and configure trusted hosts via
`DAYTONA_SSH_KNOWN_HOSTS` where supported. Do not edit plugin-owned branches locally.
Ignored evidence does not travel through git; export it explicitly before expiry.

Host storage maps the OpenCode session to its sandbox. Reconnect retrieves/starts
it; platform idle/stop/delete policies apply, with no guaranteed session TTL here.
Session deletion attempts sync and deletes the sandbox and owned twin; quitting
OpenCode alone does not request deletion. Revalidate identity and establish a new
receipt baseline on resume. Files surviving does not prove twin history survived.

## Limitations

- **Requires a Veris control plane that serves an HTTP CONNECT gateway.**
  Without one, the first tool call fails saying exactly that.
- **Git sync into the sandbox can fail with `Host key verification failed`.**
  Inherited from upstream; the agent works, but local changes are not pushed
  into the sandbox. Setting `DAYTONA_SSH_KNOWN_HOSTS` is the likely fix.
- **Receipt blind spots.** QUIC/HTTP3 and ECH are reported in `leaks`. Preserve
  the receipt's mode, integrity and blind spots when describing what was verified.
- **This release includes the newer Node trust flag.** The 0.2.1 SDK already
  installs a combined CA bundle and attempts system-store setup, but lacks the
  newer `NODE_OPTIONS` trust flag. A runtime needing that fix requires the 0.3.0 SDK release; do not disable TLS verification or overwrite the plugin's trust
  configuration to get a green run.

## License

Apache-2.0. Source: [veris-ai/veris-daytona](https://github.com/veris-ai/veris-daytona).
