# What is proven, and what is still assumed

The plan this implements is `~/.claude/plans/linked-stargazing-shore.md`.

## Proven by running it, against a real Daytona org and a real Veris twin

`npm run smoke` passes end to end, repeatedly:

```
1. sandbox + twin                             15s (snapshot cached)
2. /run/veris/ready before any command ran
3. tier: transparent   integrity: verified
4. twin answers for api.stripe.com
5. unmapped host refused: HTTP 421
6. curl https://api.stripe.com/  ->  HTTP 404      (the TWIN answered)
7. RECEIPT: twin 'stripe' received GET / -> 404
8. get() rehydrated the twin from labels in a fresh client
9. twin deleted with the sandbox — nothing leaked
```

That covers every open question the plan listed:

- **Daytona honours a snapshot `entrypoint`** — it ran on the first attempt.
- **Daytona grants `NET_ADMIN`** — `kernel redirect installed via iptables,
  exempt_uid 14741`. The transparent tier is real.
- **`veris-proxy check` works, and `VERIS_CANARY` was the right variable name** —
  `integrity: verified` is not a placeholder.
- **`Image.fromDockerfile` removes the registry dependency**: Daytona builds the
  image server-side, so nothing has to be published to test or to run.
- **Teardown is automatic** — the wrapped `delete()` removes the twin, so the
  OpenCode plugin needs no teardown code.

Plus 50 unit tests and a clean typecheck across both packages.

## Four things the live run corrected

1. **veris-proxy drops to uid 14741 and only THEN writes its trust material**, so
   the `$HOME/.veris` default resolved to `/root/.veris` and failed with EACCES
   after everything else had succeeded. Fixed with an explicit `--ca-dir` the
   uid owns.
2. **Daytona injects its own `HTTP(S)_PROXY`** (netleash, `172.20.0.1:18080`)
   and it beats create-time `envVars`, image `ENV` and `/etc/profile.d` alike.
   Hence `sbx.veris.env()`, which callers pass to their commands and the plugin
   passes automatically.
3. **The allowlist gates DNS**, not just connections. The original design assumed
   the kernel redirect would catch vendor traffic before the network layer — but
   resolution happens first, so a vendor hostname never gets an IP for the
   redirect to act on. Fail-closed either way, but for a different reason than
   documented.
4. **A registered snapshot's entrypoint is immutable**, and a stale one silently
   runs the old command line while the code believes it changed. That cost a
   debugging cycle. The proxy flags now live host-side in `proxyServeFlags()`,
   so the image only rebuilds when the image itself changes.

## Still assumed

- **Neither image is published.** `snapshot/base/` and `snapshot/opencode/` build
  fine (the base is what the smoke test runs), but nothing is pushed to
  `ghcr.io`. Until then the pinned defaults in `snapshot.ts` do not resolve, and
  callers must pass `snapshotImage: Image.fromDockerfile(...)` as the smoke test
  does.
- **The OpenCode path has not been run.** The plugin typechecks against the SDK
  and its `bash` tool passes `veris.env()`, but no `opencode` session has been
  driven end to end. Everything below it is proven; the wiring is not.
- **The cooperative fallback has never executed**, because every run so far got
  `NET_ADMIN`. Its code path is written, not exercised.
- **Only one vendor has been tested** — the environment has Stripe alone, and
  only `GET /` on it. Nothing exercises a POST, a data plane, or two services.

## Removed on purpose

`redirectHostProxy()` — an iptables rule that diverted traffic bound for
Daytona's internal enforcement proxy to ours, plus a `route_localnet` flip. It
routed around Daytona's own network control plane from inside the sandbox:
undocumented, fragile against any change on their side, and not something to
ship to customers. It also never worked. Deleted; the smoke test passes without
it, because `veris.env()` is what actually carries traffic.

The supported fix is the gateway tier — see the gateway-tier note (kept internal).

## Not built

- The gateway tier — but it is much closer than the plan assumed. The Veris
  gateway is LIVE on prod (`/v1/gateway/health` → `available: true`, and
  minting works: `gw.api.veris.ai:1080`), and Daytona's `outboundProxyUrl` is
  genuinely in the traffic path (verified: netleash returns 502 when the
  configured outbound proxy is unreachable). The single blocker is protocol —
  Daytona requires http/https, the gateway offers SOCKS5. (Details in the internal gateway-tier note.)
- The upstream PR to `@daytona/opencode` for extra create params.
- `linkedSandbox` — co-scheduling the proxy in a sandbox the agent cannot kill.

## Next

1. Drive an actual `opencode` session against `@veris-ai/daytona-opencode` and
   have the agent call `verisReceipt`.
2. Publish both images, then drop the `Image.fromDockerfile` workaround.
3. An HTTP CONNECT listener on the Veris gateway would
   remove the in-sandbox proxy, the snapshot, the NET_ADMIN dependency and the
   per-command env all at once — and put Daytona on the same tier as E2B.
