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
| `DAYTONA_API_KEY` | [app.daytona.io/dashboard/keys](https://app.daytona.io/dashboard/keys) |
| `VERIS_API_KEY` | [studio.veris.ai](https://studio.veris.ai) |
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
| `getTrustEnv()` | the CA variables injected into the sandbox |
| `deliverTo(port \| url)` | point vendor webhooks back at your sandbox |

`sbx.verisSandboxId` is the twin's id — not to be confused with `sbx.id`, which
is Daytona's.

## Options

```ts
await daytona.create({
  image: 'node:22',
  veris: {
    egress: 'strict',          // default. 'open' sets no allowlist — debugging only
    allowOut: ['internal.corp'],
    allowRegistries: true,     // default. npm, PyPI, apt, crates…
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

Every sandbox is created with two Daytona parameters: a `domainAllowList` (the
vendor hostnames the twin answers for, the gateway, the twin's data planes, and
package registries — nothing else leaves) and an `outboundProxyUrl` pointing at
the Veris gateway over HTTP CONNECT.

Daytona chains them: sandbox traffic reaches Daytona's own proxy, which drops
anything not allowlisted and forwards the rest to the gateway, which answers
vendor hostnames from the twin. Nothing of ours runs inside the sandbox, which
is why any image works.

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

## License

Apache-2.0. Source: [veris-ai/veris-daytona](https://github.com/veris-ai/veris-daytona).
