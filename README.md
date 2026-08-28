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
no proxy to start. The first run in a Daytona organization registers the Veris
snapshot once; every run after that goes straight to a sandbox.

## What the agent gets

Ten sandbox-backed tools inherited from `@daytona/opencode` (bash, read, write,
edit, multiedit, ls, glob, grep, getPreviewURL, gitSync), plus one:

**`verisReceipt`** — what the twin *received*. This is the tool that separates a
real integration from a plausible-looking one. Ask an agent to call the Stripe
API and it will report success whether or not it made the call; the transcripts
are identical. The receipts are not.

```
Veris receipt — twin sbx_a1b2c3
  interception: transparent   integrity: verified

1 request(s) reached the twin:
  stripe: 1 request(s)
    POST /v1/charges -> 200
```

An empty receipt after a green run means the code never reached its dependency.

## What is actually enforced

Every sandbox is created with a Daytona **`domainAllowList`** naming only the
twin, its data planes, the Veris control plane, and package registries. Vendor
hostnames are deliberately *absent*. That is the guarantee, and on Daytona it
turns out to bite harder than expected: **the allowlist gates DNS**, so a vendor
hostname does not resolve at all for anything that tries to dial it directly.

Traffic reaches the twin through veris-proxy's forward listener, and commands
opt in by carrying the interception environment:

```ts
const env = await sbx.veris.env()
await sbx.process.executeCommand('pytest tests/integration', undefined, env)
```

`@veris-ai/daytona-opencode` does this for you on every command the agent runs.

**Why the env is not optional, and what happens without it.** Daytona injects
its own `HTTP(S)_PROXY` into every sandbox, pointing at an internal MITM
("netleash") that enforces the allowlist. That value beats create-time
`envVars`, image `ENV`, and `/etc/profile.d` alike — `executeCommand` does not
read a login profile at all. A command that keeps Daytona's proxy gets a loud
**403**; one that bypasses proxies entirely **cannot resolve** the vendor host.
Both fail closed. There is no configuration in which a missed call quietly
reaches the real vendor.

`veris-proxy serve --transparent` additionally installs a kernel redirect
(verified working — Daytona does grant `NET_ADMIN`). The tier is probed at
bring-up, needs no configuration, and a downgrade emits a loud
`VERIS_PROXY_MODE` warning and shows up in the receipt's `mode`.

We deliberately do **not** pass veris-proxy's `--strict`. It refuses every
unmapped host, which is the right default for a standalone proxy but redundant
here — `domainAllowList` already blocks unmapped hosts at the network layer,
unbypassably. The only unmapped hosts that reach the proxy are the ones we
deliberately allowed, the package registries, and `--strict` refused those with
a `421`: `npm install` and `apt-get` broke for every command carrying
`veris.env()`. Mapped vendor hosts reach the twin either way.

**On `outboundProxyUrl`.** Daytona offers it and we cannot use it: it rejects
loopback addresses outright (`Outbound proxy host "127.0.0.1" is in a blocked
address range`), and per the SDK's own docs it is "convenience routing, not a
security boundary on its own" regardless. The allowlist is the boundary.

## Layout

| directory | ships as | what it is |
|---|---|---|
| `veris-daytona/` | `@veris-ai/daytona` | drop-in for `@daytona/sdk`; all the bring-up lives here |
| `daytona-opencode/` | `@veris-ai/daytona-opencode` | the OpenCode plugin, forked from `@daytona/opencode` 0.192.0 |
| `snapshot/base/` | `ghcr.io/veris-ai/veris-sandbox` | generic image: veris-proxy + CA, no toolchain |
| `snapshot/opencode/` | `ghcr.io/veris-ai/veris-opencode` | `FROM veris-sandbox`, adds Node + OpenCode |

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

Its default snapshot is `veris-sandbox`: veris-proxy, a CA, and no language
toolchain — because most callers bring their own code, and handing a Python
suite a Node install and an agent CLI would be presumptuous. Build on it and
point the SDK at yours:

```
FROM ghcr.io/veris-ai/veris-sandbox:0.1.0
RUN apt-get update && apt-get install -y python3 python3-pip
```

```sh
export VERIS_SNAPSHOT_IMAGE=ghcr.io/you/your-image:1.0
export VERIS_SNAPSHOT=your-image-1.0
```

`@veris-ai/daytona-opencode` is that same mechanism used once: it sets those two
variables to `veris-opencode` in its own `index.ts`, and is otherwise a thin
fork. Nothing about OpenCode reaches the SDK.

### Two meanings of "sandbox"

Held apart carefully throughout this codebase, because both are in play:

- a **Daytona sandbox** is the container the agent's code runs in (`sandbox.id`)
- a **Veris twin** is the stateful fake answering its vendor calls
  (`sandbox.verisSandboxId`, `VERIS_SANDBOX_ID`, `veris-proxy --sandbox`)

Never write "sandbox" bare in a log line, error, or doc here.

## The plugin fork is one import line

`@veris-ai/daytona` re-exports all of `@daytona/sdk` and overrides only
`Daytona`, so the entire behavioural diff against upstream is:

```diff
- } from '@daytona/sdk'
+ } from '@veris-ai/daytona'
```

in `daytona/core/session-manager.ts`. That one line carries snapshot
registration, twin provisioning, the allowlist, the CA, proxy start-up and
readiness — because all of it lives inside `create()`. Twin teardown rides along
too: `@veris-ai/daytona` wraps `delete()` on the sandbox it returns, so the
plugin's existing `sandbox.delete()` removes the twin with no plugin change at
all.

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
npm test             # 48 unit tests, no credentials needed

# live, costs money, needs all three keys:
npm run test:live -w @veris-ai/daytona
```

The live suite is the one that proves the product: it asserts interception is up
*before* the first command, that an unmapped host is blocked, that `get()`
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
