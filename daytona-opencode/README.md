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

This is the tool that separates a real integration from a plausible-looking one.
Ask an agent to call the Stripe API and it will report success whether or not it
made the call — the transcripts are identical. The receipts are not:

```
Receipt for 'stripe': ZERO requests.

The twin was reachable and answered nothing — the code under test never called
it. Do not report this change as working.
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
session's twin:

| tool | default | why |
|---|---|---|
| `create_sandbox` | `deny` | makes a twin nothing else in the session uses — the agent would seed it and report success while traffic and receipts went elsewhere |
| `delete_sandbox` | `deny` | destroys the running session's twin |
| `promote_sandbox` | `ask` | rewrites what every future run in the environment starts from |
| `reset_sandbox` | `ask` | clears the request log the receipt is read from |

Set them yourself in `opencode.json` and your values win; the plugin only fills
in what you have not.

Every one of these calls is made from your machine, never from inside the
sandbox. The twin's control plane is deliberately unreachable from the sandbox:
code that could reach `/veris/reset` could erase its own receipt.

## Why the sandbox cannot reach the real vendor

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
tools, a config hook, two paragraphs in the system prompt, and a check that the
Veris coordinates are set. The ten inherited tools, the git-sync flow and the session
bookkeeping are untouched, so upstream changes stay easy to take.

## Using the veris-sim skills alongside

[`opencode-veris-sim`](https://www.npmjs.com/package/opencode-veris-sim) carries
Veris's reference material on twins — schemas, seeding, faults, webhooks — and
composes with this plugin:

```sh
opencode plugin opencode-veris-sim -g
```

Its `/veris-sim:setup|build|fix` commands describe a different setup: your code
running on your own machine under `veris-proxy`. In a session backed by this
plugin the sandbox is the boundary and there is no proxy to start, so those
commands' steps do not apply. The reference material does.

## Limitations

- **Requires a Veris control plane that serves an HTTP CONNECT gateway.**
  Without one, the first tool call fails saying exactly that.
- **Git sync into the sandbox can fail with `Host key verification failed`.**
  Inherited from upstream; the agent works, but local changes are not pushed
  into the sandbox. Setting `DAYTONA_SSH_KNOWN_HOSTS` is the likely fix.
- **QUIC/HTTP3 and ECH are not intercepted.** Both are reported in the receipt's
  `leaks` rather than silently omitted.

## License

Apache-2.0. Source: [veris-ai/veris-daytona](https://github.com/veris-ai/veris-daytona).
