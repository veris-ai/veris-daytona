# @veris-ai/daytona

Run code in a [Daytona](https://daytona.io) sandbox where calls to
`api.stripe.com` and the rest of your vendor stack are answered by **Veris
twins** — stateful, contract-accurate fakes — with the code under test
completely unmodified.

No base-URL overrides, no injected config, no mocking library. Your code keeps
its production hostnames, credentials and SDKs; the network layer does the rest.
And every run ends with a **receipt** of what the vendor actually received.

## Install

```sh
npm i @veris-ai/daytona @daytona/sdk
```

Both, because `@daytona/sdk` is a peer dependency — that is what keeps
`err instanceof DaytonaNotFoundError` working across the package boundary.

| variable | where from |
|---|---|
| `DAYTONA_API_KEY` | [app.daytona.io/dashboard/keys](https://app.daytona.io/dashboard/keys), with the **write and delete sandboxes** permissions — a write-only key provisions boxes it can never delete |
| `VERIS_API_KEY` | [studio.veris.ai](https://studio.veris.ai) — or leave it unset after `veris login`: the CLI's profile in `~/.veris/twin.yaml` is read instead, `VERIS_PROFILE` picks one, and the variable wins whenever both exist |
| `VERIS_ENVIRONMENT_ID` | a Veris environment — it decides which vendor services your twin gets |

## Use

Change one import. Everything else in your Daytona code stays as it was.

```ts
import { Daytona } from '@veris-ai/daytona'   // was '@daytona/sdk'

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
const sbx = await daytona.create({ image: 'python:3.12-slim' })

await sbx.process.executeCommand('pytest tests/integration')

// The assertion the whole thing exists for: did the twin actually see it?
await sbx.veris.assertTouched('stripe', { method: 'POST', path: '/v1/charges' })

await sbx.delete()   // deletes the twin too
```

This package re-exports everything from `@daytona/sdk`, so it is the only import
you need to change. No particular sandbox image is required.

### Why `assertTouched` and not just a green suite

A test suite that skipped its integration and one that exercised it look
identical from inside the sandbox. So does a call your code believed it made.
The receipt is the only thing that separates them, and `assertTouched` throws
when it is empty.

## `sbx.veris`

| method | what it gives you |
|---|---|
| `receipt()` | every request the twin received, with the mode and integrity of the run |
| `receipt(service)` | the same for one service |
| `assertTouched(service, match?)` | throws unless the twin saw matching traffic |
| `services()` | what the twin answers for, and where |
| `manual(service)` | that service's manual: what it models, how its data is shaped |
| `getDataPlaneEnv()` | `{ DATABASE_URL: … }` for non-HTTP twin services |
| `getTrustEnv()` | the CA variables, as a map for a process you start |
| `trustPrelude()` | the same variables, as one line of shell `export`s |
| `patchBundledCas()` | append the Veris CA to the CA bundles your SDKs ship |
| `environmentId` | the Veris environment the twin was deployed from |
| `deliverTo(port \| url)` | point vendor webhooks back at your sandbox |

`sbx.verisSandboxId` is the twin's id — not to be confused with `sbx.id`, which
is Daytona's.

### Trust, for a command you run yourself

Daytona overwrites `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` and
`NODE_EXTRA_CA_CERTS` inside the sandbox with its own CA file, which cannot
verify the gateway's certificates. Anything not started with the right values
inherits the broken ones — `uv sync` dies with `invalid peer certificate:
UnknownIssuer`. Two shapes, because callers come in two shapes:

```ts
// You control the process's environment:
await sbx.process.executeCommand('uv sync', cwd, sbx.veris.getTrustEnv())

// You can only prefix a command line (a session, someone else's runner):
await sbx.process.executeCommand(`${sbx.veris.trustPrelude()} uv sync`)
```

And for an SDK that reads no variable because it ships its own CA file — the
measured case is stripe-python's `verify=stripe.ca_bundle_path`:

```ts
await sbx.process.executeCommand('pip install -e .', cwd, sbx.veris.getTrustEnv())
console.log(await sbx.veris.patchBundledCas())   // ['…/stripe/data/ca-certificates.crt', …]
```

Call it *after* installing dependencies — the bundles arrive with them. It is
idempotent and returns only the files it changed. Every sandbox also carries
the same patcher as a script at `/tmp/veris-patch-bundled-cas.sh`, so whoever
installed the dependencies can run it with no SDK in hand.

### Node, and what `NODE_OPTIONS` carries

Three things make a Node process in the sandbox reach the twin, and the SDK
sets all of them at create time:

| variable | why |
|---|---|
| `NODE_USE_ENV_PROXY=1` | Node ignores `HTTPS_PROXY` otherwise, and Daytona blocks a direct dial |
| `NODE_OPTIONS=--require /tmp/veris-node-proxy.cjs` | `NODE_USE_ENV_PROXY` reaches only the global agents; the preload gives every `http(s).Agent` the proxy environment, which is what an SDK with its own keep-alive agent (stripe-node, the AWS SDK, Twilio) needs |
| `NODE_OPTIONS=--use-openssl-ca` | Daytona overwrites `NODE_EXTRA_CA_CERTS`; this makes Node read the system store the Veris CA is installed into |

`NODE_OPTIONS` is one variable, so an application that sets its own value for
a command (`--experimental-vm-modules`, `--max-old-space-size`) would drop
both flags and every vendor call would fail on DNS or on the certificate. Build
the value with `verisNodeOptions(yourOptions)`, which appends the two flags
once:

```ts
import { verisNodeOptions } from '@veris-ai/daytona'
await sbx.process.executeCommand('npx jest', cwd, {
  ...sbx.veris.getTrustEnv(),
  NODE_OPTIONS: verisNodeOptions('--experimental-vm-modules'),
})
```

Clients built on undici `Pool` or `Client` hold their own dispatcher and are
not covered by the preload.

## Options

```ts
await daytona.create({
  image: 'node:22',
  veris: {
    egress: 'strict',          // default: Daytona reaches only the gateway's address.
                               // 'open': no Daytona allowlist, for a control plane
                               // that has not published the gateway's addresses
    installCa: true,           // default
    ttlMinutes: 60,
    attachSandboxId: 'sbx_…',  // reuse an existing twin; delete() will not remove it
    disabled: false,           // true = a plain Daytona sandbox, no twin
  },
})
```

Coordinates can also come from `veris.apiKey` / `veris.environmentId` /
`veris.apiBase` instead of the environment.

## How it works

Every sandbox is created with two Daytona parameters: a `networkAllowList`
holding the Veris gateway's IPv4 address as one `/32` and nothing else, and an
`outboundProxyUrl` pointing at that gateway over HTTP CONNECT.

Daytona chains them: sandbox traffic reaches Daytona's own proxy, which forwards
it to the gateway, which answers vendor hostnames from the twin and passes
public hosts — registries, git, a routeless twin's own URL — through untouched.
A process that ignores the proxy variables cannot dial out at all. Nothing of
ours runs inside the sandbox, which is why any image works.

Daytona is pinned by address, never by a hostname list, because a
`domainAllowList` set beside the proxy URL turns Daytona's egress into a
TLS-inspecting proxy that rejects the gateway's certificate (measured; see the
repository README). The address comes from the control plane's egress
credential (`gateway_ips`); an older control plane gets one DNS lookup.

Before `create()` resolves, a canary probe dials a reserved hostname only the
gateway answers, whose body carries the twin id. It proves in one request that
egress is tunnelled, that the credential reached the right twin, and that trust
is wired — and it cannot pass by accident, because outside the tunnel that host
has no listener. It runs again on every `receipt()`, so a receipt is never
reported from a sandbox whose egress cannot be vouched for.

## Errors

Every error is a `VerisError` with a `phase`, so a failure says which of the
four systems involved refused:

`credentials` · `twin-provision` · `credential-mint` · `sandbox-create` ·
`ca-install` · `canary` · `receipt` · `attach`

## Limitations

- **Requires a Veris control plane that serves an HTTP CONNECT gateway.**
  Daytona accepts only `http`/`https` outbound proxies, so a SOCKS-only gateway
  cannot be used; `create()` then fails at `credential-mint` saying so.
- **QUIC/HTTP3 and ECH are not intercepted.** The gateway relays TCP. Both are
  reported in the receipt's `leaks` rather than silently omitted.
- **The image needs `curl`.** The canary probe runs it; a slim image without
  it fails `create()` in the `canary` phase.
- **Python 3.13+ needs a gateway that mints strict-verifier-safe leaves**
  (services-sandbox#1044). Without it, `requests` fails with
  `Missing Authority Key Identifier` while `curl` and Node succeed.
- **Daytona overwrites `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE` and
  `CURL_CA_BUNDLE`** with its own CA file, which lacks the Veris CA. A command
  run through `sandbox.process` needs `sbx.veris.getTrustEnv()` as its env, or
  `sbx.veris.trustPrelude()` in front of the command line.
- **An SDK that bundles its own CA reads no variable at all.**
  `sbx.veris.patchBundledCas()` covers certifi, pip's vendored certifi,
  botocore, stripe and httplib2; anything else fails with its own error naming
  the file to add.
- **Strict mode needs the gateway's address.** It is read from the egress
  credential (`gateway_ips`), else resolved once from the proxy host. When
  neither yields an IPv4 address, `create()` fails at `credential-mint` naming
  `veris.egress: 'open'`, which sets no Daytona allowlist and still blocks a
  process that bypasses the proxy.
- **`delete()` needs `delete:sandboxes` on the Daytona key.** A write-only
  key creates boxes it cannot delete; `canDeleteSandboxes()` says so up front,
  and a box it cannot delete lives until Daytona's own auto-stop and
  auto-delete take it.
- **A very long run's receipt is a floor.** The twin's log is read in pages up
  to a budget; past it, `entry.capped` is true and the count is a minimum.

## License

Apache-2.0. Source: [veris-ai/veris-daytona](https://github.com/veris-ai/veris-daytona).

## Receipts for an individual test run

The next release adds a baseline API; existing `receipt()` calls still read the
SDK's default receipt window. Capture immediately before the isolated command:

```js
const baseline = await sandbox.veris.receiptBaseline()
// Run and await the application's own test command using this provider's SDK.
const receipt = await sandbox.veris.receiptSince(baseline, 'stripe')
const entry = receipt.services.stripe
if (!entry || entry.capped) throw new Error('Application evidence is incomplete')
```

`ReceiptRequest.id` is stable within service history. `receiptSince` validates the
execution sandbox, twin, service set/control URLs, and a uniquely marked schema
read retained in the trace both before and after paging. Reset/erasure/replacement
invalidates the baseline. Services without retained control request headers cannot
establish this baseline; the call fails explicitly. Numeric IDs alone cannot detect
all resets. Use a fresh baseline after reconnect/reset, before re-executing the test.

Pages advance IDs within a newest-ID snapshot. `entry.requests` is an observed lower
bound when `capped` is true; `incompleteReason` explains page budget, failed read or
non-progress. A failed first read throws, while a successful empty window returns
zero. `sinceId`/`untilId` identify the observed window. Control/probe tiers and
`/veris/*` paths are excluded from application entries. Unmarked vendor probes and
concurrent runs remain indistinguishable: finish them before baseline capture and
retain application response/state assertions. Preserve mode, integrity and leaks.

`veris.control(service, resource, options)` supports `manual`, `schema`,
`operations`, `data`, and `requests`; `options` contains `method`, `query`, and
`body`. Only data supports `POST`/`PATCH` writes, using the service's schema-defined
`{data: {table: [rows]}}` envelope, including fault rows. Coordinates come from the
attached twin; lifecycle and arbitrary URLs are excluded. SDK callers own write
authorization; the OpenCode plugin applies its configured write permission.
