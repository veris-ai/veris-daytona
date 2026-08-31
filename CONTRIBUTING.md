# Contributing

```sh
npm install      # workspaces link @veris-ai/daytona into the plugin
npm run build    # must come first -- see below
npm run typecheck
npm test         # unit tests, no credentials needed
```

`build` before `typecheck`, on a clean clone, is not a style preference.
`veris-daytona/dist/` is gitignored and `@veris-ai/daytona`'s `types` points
into it, so until the SDK is built the workspace link resolves to a package
with no type declarations — and the plugin's `tsc` reports that as twenty
errors in `session-manager.ts` and `veris-receipt.ts` that all trace back to
one unresolved import. The order in CI is the same, for the same reason.

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

## Releasing

Both packages version together, and the plugin depends on an exact-minor range
of the SDK, so bumping one without the other publishes a plugin that resolves an
SDK it was never built against. `version:set` does both halves:

```sh
npm run version:set 0.2.0     # both package.json files, and the cross-dependency
# update CHANGELOG.md
git commit -am "chore: 0.2.0" && git tag v0.2.0
npm run release               # build, then publish both
```

Both packages are scoped, so both carry `publishConfig.access: public` — without
it `npm publish` refuses outright.

## Conventions

- [Conventional Commits](https://www.conventionalcommits.org/) for commit
  subjects (`feat:`, `fix:`, `chore:`, `docs:`).
- [Semantic Versioning](https://semver.org/). Both packages version together.
- Comments explain *why*, not *what*. Several decisions in this repo look wrong
  until you know the constraint behind them — the inverted allowlist, the absent
  `--strict`, the `user:password` userinfo — and each carries the reason it is
  that way. If you change one, change its reason.
