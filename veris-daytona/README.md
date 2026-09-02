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

### Or skip the code: `veris-daytona run`

The same four steps as one command, for a test suite that already exists:

```sh
npx @veris-ai/daytona run --setup 'pip install -e .' -- pytest tests/integration
```

That uploads the current directory into a fresh sandbox (minus `node_modules`,
`.venv`, `.git` and the like), runs the setup command, runs the test command
streaming its output, prints the receipt, and deletes the sandbox and the twin.
The exit code is the test command's — except that a green suite whose twin
received nothing exits 1, because a pass without a receipt is not a pass.

```
Veris receipt — twin sbx_a1b2c3
  interception: gateway   integrity: verified

1 request(s) reached the twin:
  stripe: 1 request(s)
    POST /v1/customers -> 200
```

| flag | |
|---|---|
| `--repo <url> [--ref <branch>]` | clone instead of uploading; `GITHUB_TOKEN` is used for a private repo |
| `--environment <id>` | instead of `VERIS_ENVIRONMENT_ID` |
| `--require-service <name>` | the receipt must show this service, repeatable |
| `--image <name>` / `--snapshot <name>` | what to run in; default is Daytona's default snapshot |
| `--env KEY=VALUE` | exported to both commands, repeatable |
| `--timeout <seconds>` | for the test command; default 1800 |
| `--keep` | leave the sandbox and twin up and print their ids |

`veris-daytona run --help` lists everything.

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
- **The image needs `curl`.** The canary probe runs it; a slim image without
  it fails `create()` in the `canary` phase.
- **Python 3.13+ needs a gateway that mints strict-verifier-safe leaves**
  (services-sandbox#1044). Until deployed, `requests` fails with
  `Missing Authority Key Identifier` while `curl` and Node succeed.

## License

Apache-2.0. Source: [veris-ai/veris-daytona](https://github.com/veris-ai/veris-daytona).
