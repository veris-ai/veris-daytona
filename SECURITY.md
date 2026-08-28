# Security

## Reporting a vulnerability

Email **security@veris.ai**. Please do not open a public issue for a
vulnerability report.

## What this package is responsible for

`@veris-ai/daytona` decides what a Daytona sandbox may reach, so a few
properties are load-bearing rather than incidental. If you find a way to break
any of them, that is a vulnerability:

- **A sandbox cannot reach a host outside its `domainAllowList`.** Enforcement
  is Daytona's, at the network layer; this package only computes the list.
- **A vendor hostname on that list is answered by the Veris gateway, not by the
  real vendor.** The allowlist is not the boundary here — the gateway is. A path
  that reaches a real vendor API from inside a Veris sandbox is the highest
  severity thing in this repo.
- **`receipt()` never reports traffic it cannot vouch for.** Every call
  re-runs the canary probe first; a receipt read from a sandbox whose egress was
  detached must fail, not return counts.
- **Control-plane responses are treated as untrusted input.** They are validated
  before reaching a URL, a shell command, or an environment variable — see
  `sanitizeTrustEnv`, `isSafeEnvName`, and the host/address checks in
  `gateway.ts`. A response that can inject into any of those is a vulnerability.
- **The Veris API key is never sent to a host named by sandbox labels.** A
  compromised sandbox must not be able to redirect it.

## What it is not responsible for

- The isolation of the Daytona sandbox itself, or Daytona's enforcement of
  `domainAllowList` — report those to Daytona.
- The twin's own behaviour, which is the Veris platform.
- QUIC/HTTP3 and ECH, which the gateway does not intercept. These are reported
  in the receipt's `leaks` rather than silently omitted; that is a documented
  limitation, not a vulnerability.
