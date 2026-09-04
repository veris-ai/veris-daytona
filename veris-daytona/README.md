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
| `--keep` | leave the sandbox up afterwards, and the twin if `run` made it |

`veris-daytona run --help` lists everything.

### Or hand the wired box to something else: `provision`, `push`, `exec`, `teardown`

`run` does the whole job in one command, and it stays. But when the thing that
installs the dependencies and runs the suite is another tool — the `veris` CLI,
a CI step, an agent — what you want from this package is the first half only:

```sh
box=$(npx @veris-ai/daytona provision --sandbox sbx_a1b2c3 --image python:3.12)
```

That creates a sandbox attached to a twin you already have, does every
Veris-shaped thing — the egress credential, the allowlist and its 20-domain
fit, the outbound proxy, the CA bundle, the canary, the trust variables — and
stops. Nothing is uploaded, nothing is run, nothing is deleted. One JSON object
goes to stdout and every human line to stderr, so `$box` is parseable:

```json
{
  "daytonaSandboxId": "e2a1…",
  "verisSandboxId": "sbx_a1b2c3",
  "verisEnvironmentId": "env_9f…",
  "ownsTwin": false,
  "workDir": "/home/daytona/veris-run",
  "caBundlePath": "/tmp/veris-ca-bundle.crt",
  "trustEnv": { "SSL_CERT_FILE": "/tmp/veris-ca-bundle.crt", "…": "…" },
  "trustPrelude": "export SSL_CERT_FILE='/tmp/veris-ca-bundle.crt'; …",
  "patchBundledCasCommand": "sh /tmp/veris-patch-bundled-cas.sh",
  "pushCommand": "veris-daytona push e2a1…",
  "execCommand": "veris-daytona exec e2a1… -- <command>",
  "services": ["stripe", "github"],
  "expiresAt": "2026-09-04T12:00:00.000Z",
  "autoStopMinutes": 30,
  "autoDeleteMinutes": 60
}
```

| flag | |
|---|---|
| `--sandbox <twin-id>` | the twin to attach to — **required**; `veris up` prints its id |
| `--image <name>` / `--snapshot <name>` | what to run in; default is Daytona's default snapshot |
| `--allow-out <host>` | extra hostname the sandbox may reach, repeatable |
| `--env KEY=VALUE` | set as a sandbox environment variable, repeatable |

Daytona's allowlist is fixed at create, so a later `push --repo` needs
`--allow-out github.com` said here.

From there the box is yours. Reading the receipt and deciding what it proved is
the caller's job; that is the whole point of the split.

### Getting code in and running it: `push` and `exec`

Daytona has no route into a box that already exists. Their CLI (v0.210.0) has no
upload, copy or sync command; `daytona ssh` takes exactly one argument, so there
is no `tar | ssh` and no scp or rsync behind it; `--context` is a Docker build
context that only exists on `create`, which `provision` owns; and `git clone`
inside the box needs the git host on an allowlist fixed at create. So two verbs
do it:

```sh
id=$(echo "$box" | jq -r .daytonaSandboxId)

npx @veris-ai/daytona push "$id"                       # tars the cwd into workDir
npx @veris-ai/daytona exec "$id" -- pip install -e .
npx @veris-ai/daytona exec "$id" -- sh /tmp/veris-patch-bundled-cas.sh
npx @veris-ai/daytona exec "$id" -- python -m pytest tests/integration
```

`push` uploads the current directory, minus what gets rebuilt inside
(`node_modules`, `.venv`, `dist`, `__pycache__`, …), and unpacks it in the same
`workDir` the JSON named — so the two chain without carrying the path between
them. `--repo <url> --ref <branch>` clones instead, using `GITHUB_TOKEN` for a
private one.

`exec` runs one command with `trustEnv` already exported, which is the part that
matters: `daytona exec` has no `--env` flag at all, so a command run through it
inherits Daytona's own CA file and fails on the gateway's certificate unless you
retype the trust prelude every single time. It streams output as it happens
rather than returning at the end, takes `--cwd`, repeatable `--env KEY=VALUE`
and `--timeout <seconds>`, and exits with the command's own status.

Neither reads a receipt or passes a verdict — take a watermark before and read
`veris sandbox trace --since` after. And once the dependencies are installed,
run `patchBundledCasCommand` **inside the box** to patch the CA bundles an SDK
ships with it; the script is already in there, so a shell caller needs nothing
from this package.

### Taking it back: `teardown`

However it went:

```sh
npx @veris-ai/daytona teardown "$(echo "$box" | jq -r .daytonaSandboxId)"
```

`teardown` deletes the sandbox and says what it did about the twin: one this
package created goes with it, one it attached to — always the case after
`provision` — is yours and is left running. It exits 1 when there is no such
sandbox, saying plainly that no twin was touched.

Nothing deletes a provisioned box for you, so it comes up with its own brakes:
it stops after 30 idle minutes, Daytona deletes it an hour after that, and it
is destroyed 4 hours after creation whatever state it is in. The twin's TTL is
untouched — it belongs to whoever created the twin.

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
idempotent and returns only the files it changed. `veris-daytona run` calls it
for you, between `--setup` and the command; a sandbox from `provision` carries
the same patcher as a script at `/tmp/veris-patch-bundled-cas.sh`, so whoever
installed the dependencies can run it with no SDK in hand.

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

The list also carries the twin's own host when a service can only be reached
there — one with no vendor routes has no hostname for the gateway to intercept,
so its twin URL is the only way in. Daytona caps the whole list at 20 domains,
which a large environment fills; see the Limitations for what gives way.

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
  `CURL_CA_BUNDLE`** with its own CA file, which lacks the Veris CA. `run`
  exports the Veris bundle on every command it runs; a command run through
  `sandbox.process` yourself needs `sbx.veris.getTrustEnv()` as its env, or
  `sbx.veris.trustPrelude()` in front of the command line.
- **An SDK that bundles its own CA reads no variable at all.**
  `sbx.veris.patchBundledCas()` covers certifi, pip's vendored certifi,
  botocore, stripe and httplib2; anything else fails with its own error naming
  the file to add.
- **Daytona allows 20 domains, and a large environment fills the list.** The
  vendor hostnames, the gateway, the data planes and your `allowOut` are kept;
  the default registries are trimmed from the tail to fit, and what was dropped
  is printed. Required hosts alone exceeding 20 fails at `sandbox-create` with
  the count and the knobs, rather than as a raw Daytona refusal.
- **A very long run's receipt is a floor.** The twin's log is read in pages up
  to a budget; past it, `entry.capped` is true and `run` prints `≥N`.

## License

Apache-2.0. Source: [veris-ai/veris-daytona](https://github.com/veris-ai/veris-daytona).
