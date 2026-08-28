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
plus one.

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
Platforms Inc.), and a deliberately small one: one changed import, one added
tool, one paragraph in the system prompt, and a check that the Veris
coordinates are set. The ten inherited tools, the git-sync flow and the session
bookkeeping are untouched, so upstream changes stay easy to take.

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
