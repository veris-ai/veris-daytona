# Veris for Daytona

Run code in a [Daytona](https://daytona.io) sandbox where calls to
`api.stripe.com` and the rest of your vendor stack are answered by **Veris
twins** — stateful, contract-accurate fakes — with the code under test
completely unmodified.

No base-URL overrides, no injected config, no mocking library. Your code keeps
its production hostnames, credentials and SDKs; the network layer does the rest.
And every run ends with a **receipt** of what the vendor actually received.

Two packages:

| package | what it is |
|---|---|
| **`@veris-ai/daytona`** | a drop-in for `@daytona/sdk`. Use it directly to run your own code against twins. |
| **`@veris-ai/daytona-opencode`** | an [OpenCode](https://opencode.ai) plugin. One line, and every agent session runs in one of these sandboxes. |

---

## `@veris-ai/daytona`

```sh
npm i @veris-ai/daytona @daytona/sdk
```

Both, because `@daytona/sdk` is a peer dependency — that is what keeps
`err instanceof DaytonaNotFoundError` working across the boundary.

| variable | where from |
|---|---|
| `DAYTONA_API_KEY` | [app.daytona.io/dashboard/keys](https://app.daytona.io/dashboard/keys) |
| `VERIS_API_KEY` | your Veris dashboard |
| `VERIS_ENVIRONMENT_ID` | a Veris environment — it decides which vendor services your twin gets |

Then change one import:

```ts
import { Daytona } from '@veris-ai/daytona'   // was '@daytona/sdk'

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
const sbx = await daytona.create({ image: 'python:3.12-slim' })

await sbx.process.executeCommand('pytest tests/integration')

// The assertion the whole thing exists for: did the twin actually see it?
await sbx.veris.assertTouched('stripe', { method: 'POST', path: '/v1/charges' })

await sbx.delete()   // deletes the twin too
```

Nothing else in your Daytona code changes — everything the SDK exports comes
through untouched. No particular image is required.

`sbx.veris` is the whole added surface: `receipt()`, `assertTouched()`,
`services()`, `getDataPlaneEnv()`, `getTrustEnv()`, `deliverTo()`.

### Why `assertTouched` and not just a green suite

A test suite that skipped its integration and one that exercised it look
identical from inside the sandbox. So does a call your code believed it made.
The receipt is the only thing that separates them, and `assertTouched` throws
when it is empty.

---

## `@veris-ai/daytona-opencode`

The same sandbox, with an agent in it.

```jsonc
// opencode.json
{ "plugin": ["@veris-ai/daytona-opencode"] }
```

Same three environment variables, then `opencode`. Every session runs in a
Daytona sandbox whose vendor calls reach your twin.

The agent gets the ten sandbox-backed tools inherited from `@daytona/opencode`
(bash, read, write, edit, multiedit, ls, glob, grep, getPreviewURL, gitSync),
plus one:

**`verisReceipt`** — what the twin *received*. Ask an agent to call the Stripe
API and it will report success whether or not it made the call; the transcripts
are identical. The receipts are not.

```
Veris receipt — twin sbx_a1b2c3
  interception: gateway   integrity: verified

1 request(s) reached the twin:
  stripe: 1 request(s)
    POST /v1/charges -> 200
```

An empty receipt after a green run means the code never reached its dependency.
The system prompt tells the agent to check it before claiming an integration
works — but you can always ask yourself.

---

## How it works

Every sandbox is created with two Daytona parameters:

- **`domainAllowList`** — the vendor hostnames the twin answers for, the gateway
  itself, the twin's data planes, and package registries. Nothing else leaves.
- **`outboundProxyUrl`** — the Veris gateway, over HTTP CONNECT.

Daytona chains them: sandbox traffic goes to Daytona's own proxy, which drops
anything not allowlisted and forwards the rest to the gateway, which answers
vendor hostnames from the twin. This is the same tier `@veris-ai/e2b` uses.

Nothing of ours runs inside the sandbox, so any image works — there is no
snapshot to register, no `NET_ADMIN` to request, and no environment to thread
through individual commands.

**Why allowlisting vendor hostnames is not a leak.** It reads backwards, but the
allowlist is not what stands between the sandbox and the real vendor — the
gateway is. A vendor host that is *absent* never reaches the gateway and so
never reaches the twin; it is simply blocked. And a client cannot go around
Daytona's proxy to reach the host directly: verified, with every proxy variable
stripped, an allowlisted host is still intercepted rather than dialled.

**The canary.** Before `create()` resolves, a probe dials a reserved hostname
only the gateway answers, whose body carries the twin id. Green proves in one
request that egress really is tunnelled, that the credential demuxed to the
right twin, and that trust is wired. Dialled outside the tunnel there is no
listener, so it cannot pass by accident — which is what makes the receipt worth
reading. It runs again on every `receipt()`.

**CA trust**, which is subtler here than it looks. A MITM gateway presents a
certificate it forged for the vendor hostname, and whoever validates it must
trust the signing CA. On Daytona there are *two* proxies in the chain and the
client's TLS peer is the near one: Daytona terminates TLS with a certificate
signed by **its** CA, already trusted in the image, and re-originates to the
gateway. Verified — a vendor call succeeds with `--cacert` naming only Daytona's
CA. So the Veris CA is not currently in the validation path.

It is installed anyway. The day Daytona tunnels `CONNECT` end-to-end — the
ordinary behaviour for an HTTP proxy — the gateway's certificate reaches the
client directly and nothing works without it. A bundle is assembled inside the
sandbox from the distribution's public roots plus ours, with no image
requirements, and the trust variables Daytona does not itself set (`PIP_CERT`,
`CARGO_HTTP_CAINFO`, `DENO_CERT` and a dozen more) point at it.

**On `socks_address`.** The credential also carries a SOCKS endpoint, which is
what `@veris-ai/e2b` uses. Daytona cannot: it accepts only `http`/`https`
outbound proxies (`Unsupported outbound proxy scheme "socks5h"`), which is why
the gateway grew an HTTP CONNECT listener.

## Status and known limitations

Verified end to end against a live Daytona organization and a live Veris twin,
through both entry points.

The SDK path, which `npm run smoke` reproduces: sandbox and twin up, the canary
answering before the first command, an unmapped host refused, a vendor call
answered by the twin, and the receipt recording it.

The plugin path, driven through a real `opencode` session: the agent ran in a
Daytona sandbox, called `https://api.stripe.com/v1/charges`, and `verisReceipt`
reported `GET /v1/charges -> 401` against `interception: gateway,
integrity: verified`. Told to claim success *without* making the call, the same
tool reported `ZERO requests` — which is the entire point of it.

- **Requires a control plane that serves an HTTP CONNECT gateway.** Without one,
  `create()` fails at `credential-mint` naming exactly that.
- **Interception currently depends on Daytona intercepting TLS itself.** The
  client's certificate chain terminates at Daytona's CA, not ours. If Daytona
  ever tunnels `CONNECT` end-to-end instead, the Veris CA becomes load-bearing —
  it is already installed for that reason, but that path is untested.
- **Git sync into the sandbox fails with `Host key verification failed`.**
  Inherited from upstream `@daytona/opencode`, not introduced by this fork —
  the agent works, but local changes are not pushed into the sandbox. Likely
  wants `DAYTONA_SSH_KNOWN_HOSTS`.
- **QUIC/HTTP3 and ECH are not intercepted.** The gateway relays TCP; both are
  reported in the receipt's `leaks` rather than silently omitted.

## Layout

| directory | package |
|---|---|
| `veris-daytona/` | `@veris-ai/daytona` |
| `daytona-opencode/` | `@veris-ai/daytona-opencode`, forked from `@daytona/opencode` 0.192.0 |

Both npm packages sit under the `@veris-ai` scope, which already says "Veris",
so neither name repeats it. `@veris-ai/daytona` is the engine integration,
mirroring `@veris-ai/e2b`; `@veris-ai/daytona-opencode` is the plugin built on
it. `<engine>-opencode` scales: a future E2B-backed plugin is
`@veris-ai/e2b-opencode`.

### Two meanings of "sandbox"

Held apart carefully throughout this codebase, because both are in play:

- a **Daytona sandbox** is the container your code runs in (`sandbox.id`)
- a **Veris twin** is the stateful fake answering its vendor calls
  (`sandbox.verisSandboxId`, `VERIS_SANDBOX_ID`)

Never write "sandbox" bare in a log line, error, or doc here.

### The plugin fork is one import line

`@veris-ai/daytona` re-exports all of `@daytona/sdk` and overrides only
`Daytona`, so the entire behavioural diff against upstream is:

```diff
- } from '@daytona/sdk'
+ } from '@veris-ai/daytona'
```

in `daytona/core/session-manager.ts`. That one line carries twin provisioning,
the egress credential, the allowlist, the outbound proxy, CA trust and the
canary — because all of it lives inside `create()`. Twin teardown rides along
too: `@veris-ai/daytona` wraps `delete()` on the sandbox it returns, so the
plugin's existing `sandbox.delete()` removes the twin with no plugin change at
all. Beyond that the fork adds one tool, registers it, one paragraph in the
system prompt, and a check that the Veris coordinates are set.

`@daytona/sdk` is a **peer** dependency, which is load-bearing. The plugin
branches on `err instanceof DaytonaNotFoundError` to tell "this sandbox is gone,
replace it" from "transient failure, keep the session mapping" — and
`tools/bash.ts` imports that class from `@daytona/sdk` directly while
`session-manager.ts` imports from us. Two copies of the SDK in one tree and
those checks silently return `false`. `tests/unit/exports.test.ts` fails loudly
if that ever regresses.

## Developing

See [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
npm install          # workspaces link @veris-ai/daytona into the plugin
npm run typecheck
npm test             # unit tests, no credentials needed

# live, costs money, needs all three keys:
npm run smoke
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) — `daytona-opencode/` is
a fork of `@daytona/opencode`, Copyright Daytona Platforms Inc.
