# Contributing

```sh
npm install      # workspaces link @veris-ai/daytona into the plugin
npm run typecheck
npm test         # unit tests, no credentials needed
npm run build
```

## Live verification

`scripts/smoke.ts` runs the whole path against a real Daytona organization and a
real Veris twin — it creates a sandbox, calls a vendor hostname, reads the
receipt, and cleans up after itself:

```sh
export DAYTONA_API_KEY=… VERIS_API_KEY=… VERIS_ENVIRONMENT_ID=…
npm run smoke
```

It costs money and it deletes what it creates, including on failure. A leaked
twin bills silently, so if you change the cleanup path, check it.

## Layout

| directory | package |
|---|---|
| `veris-daytona/` | `@veris-ai/daytona` — the engine integration |
| `daytona-opencode/` | `@veris-ai/daytona-opencode` — the OpenCode plugin |

The root package is private and publishes nothing; both packages are siblings so
npm links them. Do not move either to the repo root — npm links sibling
workspaces, never the root, and the plugin would stop resolving the SDK.

`daytona-opencode/` is a fork of `@daytona/opencode` (Apache-2.0). Its diff
against upstream is deliberately tiny — one import, one tool, one prompt
section, one credentials check — so that upstream changes stay easy to take.
Keep it that way: if a change wants to live in a forked file, check first
whether it belongs in `@veris-ai/daytona` instead.

## Conventions

- [Conventional Commits](https://www.conventionalcommits.org/) for commit
  subjects (`feat:`, `fix:`, `chore:`, `docs:`).
- [Semantic Versioning](https://semver.org/). Both packages version together.
- Comments explain *why*, not *what*. Several decisions in this repo look wrong
  until you know the constraint behind them — the inverted allowlist, the absent
  `--strict`, the `user:password` userinfo — and each carries the reason it is
  that way. If you change one, change its reason.
