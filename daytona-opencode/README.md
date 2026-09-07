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

The ten sandbox-backed tools from [`@daytona/opencode`](https://www.npmjs.com/package/@daytona/opencode)
— bash, read, write, edit, multiedit, ls, glob, grep, getPreviewURL, gitSync —
plus two, and the Veris MCP server.

**`verisReceipt`** reports what the twin *received*.

```
Veris receipt — twin sbx_a1b2c3
  interception: gateway   integrity: verified

1 request(s) reached the twin:
  stripe: 1 request(s)
    POST /v1/charges -> 200
```

Receipts are bounded views of the twin's request log, including earlier work and
control traffic. Take a baseline and read again after the application's own flow;
a nonzero total alone does not prove that flow ran. The full view shows at most
20 entries per service; the service-filtered view shows at most 50 and omits the
twin id. At zero total traffic, the full view omits service names as well; use
`verisTwin` to discover them. Keep response/state assertions and obtain raw trace
data when the summary cannot attribute new requests.

A successful application exit needs matching twin evidence. For example, an empty
service log leaves arrival unproven:

```
Receipt for 'stripe': ZERO requests.

No requests appear in this returned service log; arrival for the current run is unproven.
Do not report this change as working.
```

The system prompt tells the agent to check it before claiming an integration
works. You can also just ask for it.

**`verisTwin`** names the twin and what it answers for — and with a service
argument, returns that service's manual: what it models and how its data is
shaped.

```
Veris twin sbx_a1b2c3

1 service(s):
  stripe (ready) -> https://gw.api.veris.ai/stripe
```

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

The sandbox is created with a `domainAllowList` — the vendor hostnames the twin
answers for, the Veris gateway, the twin's data planes, and package registries —
and an `outboundProxyUrl` pointing at the gateway. Daytona drops anything not on
the list and forwards the rest to the gateway, which answers vendor hostnames
from the twin. `npm install` still works; `api.stripe.com` reaches your twin.

Everything above happens inside `@veris-ai/daytona`, which this plugin uses in
place of `@daytona/sdk`. See [its README](https://www.npmjs.com/package/@veris-ai/daytona)
if you want the same thing without an agent.

## Relationship to `@daytona/opencode`

This is a fork of `@daytona/opencode` 0.192.0 (Apache-2.0, Copyright Daytona
Platforms Inc.), and a deliberately small one: one changed import, two added
tools, a config hook, provider instructions in the system prompt, and a check that the
Veris coordinates are set. The ten inherited tools, the git-sync flow and the session
bookkeeping are untouched, so upstream changes stay easy to take.

## Adding Veris's skills alongside

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

## Limitations

- **Requires a Veris control plane that serves an HTTP CONNECT gateway.**
  Without one, the first tool call fails saying exactly that.
- **Git sync into the sandbox can fail with `Host key verification failed`.**
  Inherited from upstream; the agent works, but local changes are not pushed
  into the sandbox. Setting `DAYTONA_SSH_KNOWN_HOSTS` is the likely fix.
- **Receipt blind spots.** QUIC/HTTP3 and ECH are reported in `leaks`. Preserve
  the receipt's mode, integrity and blind spots when describing what was verified.
- **Published trust support differs from this source.** The 0.2.1 SDK already
  installs a combined CA bundle and attempts system-store setup, but lacks the
  newer `NODE_OPTIONS` trust flag. A runtime needing that fix requires a later
  published SDK; do not disable TLS verification or overwrite the plugin's trust
  configuration to get a green run.

## License

Apache-2.0. Source: [veris-ai/veris-daytona](https://github.com/veris-ai/veris-daytona).
