# OpenCode, in a Daytona sandbox, against a Veris twin

Add one line to `opencode.json` and every OpenCode session in that repo runs in
a Daytona sandbox whose outbound vendor API calls are answered by a Veris twin —
with a receipt of what the vendor actually received.

```jsonc
// opencode.json
{ "plugin": ["@veris-ai/daytona-opencode"] }
```

```sh
export DAYTONA_API_KEY=…       # https://app.daytona.io/dashboard/keys
export VERIS_API_KEY=…         # https://app.veris.ai
export VERIS_ENVIRONMENT_ID=…  # which vendor services your twin gets
```

Then `opencode`. No image to build, no snapshot to register, no network config,
no proxy to start — the sandbox's egress is routed through the Veris gateway,
which answers vendor hostnames from your twin.

## What the agent gets

Ten sandbox-backed tools inherited from `@daytona/opencode` (bash, read, write,
edit, multiedit, ls, glob, grep, getPreviewURL, gitSync), plus one:

**`verisReceipt`** — what the twin *received*. This is the tool that separates a
real integration from a plausible-looking one. Ask an agent to call the Stripe
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

## How it works

Every sandbox is created with two Daytona parameters:

- **`domainAllowList`** — the vendor hostnames the twin answers for, the gateway
  itself, the twin's data planes, and package registries. Nothing else leaves.
- **`outboundProxyUrl`** — the Veris gateway, reached over HTTP CONNECT.

Daytona chains them: sandbox traffic goes to Daytona's own proxy, which drops
anything not allowlisted and forwards the rest to the gateway, which answers
vendor hostnames from the twin.

Nothing of ours runs inside the sandbox but a CA file, so **any image works** —
there is no snapshot to register, no `NET_ADMIN` to request, and no environment
to thread through individual commands.

**Why allowlisting vendor hostnames is not a leak.** It reads backwards, but the
allowlist is not what stands between the sandbox and the real vendor — the
gateway is. A vendor host that is *absent* never reaches the gateway and so
never reaches the twin; it is simply blocked. And a client cannot go around
Daytona's proxy to reach the host directly: verified, with every proxy variable
stripped, an allowlisted host is still intercepted rather than dialled.

**Two things still happen inside the sandbox**, both at create time and both
before `create()` resolves:

1. **The gateway's CA is installed.** This is not optional. The gateway
   terminates TLS and presents a certificate it forged for the vendor hostname;
   a client that does not trust the Veris CA rejects it, and the call dies on
   certificate validation. No CA means no interception — loudly, never silently.

   Rather than require anything of the image, a bundle is assembled inside the
   sandbox — the distribution's public roots plus ours — and every trust
   variable (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
   `NODE_EXTRA_CA_CERTS`, and a dozen more) is injected at create time pointing
   at it. Where root and the tooling exist, the system store, the JVM cacerts
   and NSS databases are updated too — best-effort, for stacks like Java that
   honour no CA environment variable at all. If the bundle cannot be assembled,
   `create()` fails at `ca-install` rather than handing back a sandbox that
   would fail mysteriously later.

2. A **canary probe** dials a reserved hostname only the gateway answers, whose
   body carries the twin id. Green proves in one request that egress really is
   tunnelled, that the credential demuxed to the right twin, and that the CA
   install worked. Dialled outside the tunnel there is no listener, so it cannot
   pass by accident — which is what makes the receipt worth reading. It runs
   again on every `receipt()`.

**On the SOCKS endpoint.** The credential also carries `socks_address`, which is
what `@veris-ai/e2b` uses. Daytona cannot: it accepts only `http`/`https`
outbound proxies (`Unsupported outbound proxy scheme "socks5h"`), which is why
the gateway grew an HTTP CONNECT listener and why this package requires a
control plane that returns `connect_address`.

## Layout

| directory | ships as | what it is |
|---|---|---|
| `veris-daytona/` | `@veris-ai/daytona` | drop-in for `@daytona/sdk`; all the bring-up lives here |
| `daytona-opencode/` | `@veris-ai/daytona-opencode` | the OpenCode plugin, forked from `@daytona/opencode` 0.192.0 |

Both packages sit under the `@veris-ai` scope, which already says "Veris" — so
neither name repeats it. `@veris-ai/daytona` is the engine integration (mirroring
`@veris-ai/e2b`); `@veris-ai/daytona-opencode` is the OpenCode plugin built on
it. A future E2B-backed plugin would be `@veris-ai/e2b-opencode`, and the pattern
holds.

### The SDK is generic; OpenCode is one consumer

`@veris-ai/daytona` is the Veris integration for Daytona, exactly as
`@veris-ai/e2b` is for E2B — it knows nothing about agents. Use it directly to
run *your* code against twins:

```ts
import { Daytona } from '@veris-ai/daytona'   // was '@daytona/sdk'

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
const sbx = await daytona.create()
await sbx.process.executeCommand('pytest tests/integration')
await sbx.veris.assertTouched('stripe')
await sbx.delete()                            // deletes the twin too
```

It imposes no image. Bring whatever your code needs:

```ts
const sbx = await daytona.create({ image: 'python:3.12-slim' })
```

`@veris-ai/daytona-opencode` is one caller of it, and nothing about OpenCode
reaches the SDK.

### Two meanings of "sandbox"

Held apart carefully throughout this codebase, because both are in play:

- a **Daytona sandbox** is the container the agent's code runs in (`sandbox.id`)
- a **Veris twin** is the stateful fake answering its vendor calls
  (`sandbox.verisSandboxId`, `VERIS_SANDBOX_ID`)

Never write "sandbox" bare in a log line, error, or doc here.

## The plugin fork is one import line

`@veris-ai/daytona` re-exports all of `@daytona/sdk` and overrides only
`Daytona`, so the entire behavioural diff against upstream is:

```diff
- } from '@daytona/sdk'
+ } from '@veris-ai/daytona'
```

in `daytona/core/session-manager.ts`. That one line carries twin provisioning,
the egress credential, the allowlist, the outbound proxy, the CA install and the
canary — because all of it lives inside `create()`. Twin teardown rides along
too: `@veris-ai/daytona` wraps `delete()` on the sandbox it returns, so the
plugin's existing `sandbox.delete()` removes the twin with no plugin change at
all.

Beyond that import the fork adds one tool (`verisReceipt`), registers it, a
paragraph in the system prompt, and a check that the Veris coordinates are set.
Nothing else in the ten inherited tools, the git-sync flow or the session
bookkeeping is touched.

`@daytona/sdk` is a **peer** dependency, which is load-bearing. The plugin
branches on `err instanceof DaytonaNotFoundError` to tell "this sandbox is gone,
replace it" from "transient failure, keep the session mapping" — and
`tools/bash.ts` imports that class from `@daytona/sdk` directly while
`session-manager.ts` now imports from us. Two copies of the SDK in one tree and
those checks silently return `false`. `tests/unit/exports.test.ts` fails loudly
if that ever regresses.

## Developing

```sh
npm install          # workspaces link @veris-ai/daytona into the plugin
npm run typecheck
npm test             # 42 unit tests, no credentials needed

# live, costs money, needs all three keys:
npm run test:live -w @veris-ai/daytona
```

`scripts/smoke.ts` is the one that proves the product: it asserts the canary
answers before the first command, that an unmapped host is blocked, that a
vendor call lands on the twin and shows up in the receipt, that `get()`
rehydrates the Veris surface in a fresh process (the resumed-session path), and
that deleting the sandbox leaves no twin behind.

## Status and known limitations

- **Requires a control plane that serves an HTTP CONNECT gateway.** Daytona
  accepts only http/https outbound proxies (`Unsupported outbound proxy scheme
  "socks5h"`), so a gateway offering SOCKS5 alone cannot be used at all. Without
  it `create()` fails at `credential-mint` naming exactly that.
- **A client that reads neither a CA environment variable nor a trust store
  cannot be intercepted.** It fails TLS rather than reaching the real vendor, so
  this is a broken call, never a silent one — but it is a broken call.
- **The OpenCode plugin has not been driven end to end.** The SDK path is
  verified by `npm run smoke`; no `opencode` session has been run against the
  plugin itself.
- **QUIC/HTTP3 and ECH are not intercepted.** The gateway relays TCP; both are
  reported in the receipt's `leaks` rather than silently omitted.

## Developing

```sh
npm install          # workspaces link @veris-ai/daytona into the plugin
npm run typecheck
npm test             # 42 unit tests, no credentials needed

# live, costs money, needs all three keys:
npm run test:live -w @veris-ai/daytona
```

`scripts/smoke.ts` is the one that proves the product: it asserts the canary
answers before the first command, that an unmapped host is blocked, that a
vendor call lands on the twin and shows up in the receipt, that `get()`
rehydrates the Veris surface in a fresh process (the resumed-session path), and
that deleting the sandbox leaves no twin behind.

## Status and known limitations

Verified end to end against a live Daytona organization and a live Veris twin:
sandbox and twin up in ~15s, interception live before the first command, an
unmapped host refused, a vendor call answered by the twin, and the receipt
recording it. `npm run smoke` reproduces the whole path.

Known limitations, in the order you are likely to hit them:

- **The sandbox images are not published yet.** Until
  `ghcr.io/veris-ai/veris-sandbox` and `ghcr.io/veris-ai/veris-opencode` are on
  the registry, pass your own build:
  `veris: { snapshotImage: Image.fromDockerfile('snapshot/base/Dockerfile') }`,
  as `scripts/smoke.ts` does.
- **The OpenCode plugin has not been driven end to end.** It typechecks against
  the SDK and its `bash` tool passes the interception environment, but no
  `opencode` session has been run against it.
- **The cooperative fallback has not been exercised.** Every run so far received
  `NET_ADMIN`, so the transparent path is the only one with live coverage.
- **Commands must carry `veris.env()`.** Anything launched without it fails
  closed — a 403 from Daytona's proxy, or a hostname that will not resolve —
  rather than reaching the real vendor. The plugin does this automatically;
  direct SDK callers must pass it.
- **QUIC/HTTP3 and ECH are not intercepted.** They are reported in the receipt's
  `leaks` rather than silently omitted.
