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

**The `release` workflow is the only way to publish.** There is deliberately no
`npm run release`: a publish from a laptop uses a long-lived token, which means
no OIDC, no provenance attestation, and none of the guards below. `0.1.0` went
out that way and is the one version on npm carrying a registry signature but no
build attestation.

Both packages version together, and the plugin depends on an exact-minor range
of the SDK, so bumping one without the other publishes a plugin that resolves an
SDK it was never built against. `version:set` does both halves:

```sh
npm run version:set 0.2.0     # both package.json files, and the cross-dependency
# update CHANGELOG.md
git commit -am "chore: 0.2.0"
# open a PR, get it merged
```

Then **Actions → release → Run workflow**. Tick `dry_run` first if you want the
rehearsal: it builds, typechecks, tests and packs, asserting on tarball contents,
size and the absence of a stray `node_modules`, then stops before publishing.
Run it again without `dry_run` to ship. It publishes the SDK first, then the
plugin, then asserts both landed with a provenance attestation, then tags and
cuts the GitHub release.

Both packages are scoped, so both carry `publishConfig.access: public` — without
it `npm publish` refuses outright.

### If a release fails half-way

Re-run it. Every step that touches the outside world checks first whether it has
already been done, so a run that published the SDK and then died on the plugin
will, on the re-run, skip the SDK and publish only the plugin. The same is true
of the git tag and the GitHub release.

The one thing it will not do is release a version that has *fully* shipped: if
both packages are already on npm at that version, the run fails with "nothing to
do", which almost always means the bump was forgotten.

### Prereleases

`version:set` accepts them (`0.2.0-rc.1`) and the workflow derives the npm
dist-tag from the prerelease identifier — `0.2.0-rc.1` publishes under `rc`,
`0.2.0-alpha.3` under `alpha`, and a plain `0.2.0` under `latest`. This is not
optional politeness: npm 11 implemented [RFC 7][rfc7] and now refuses to publish
a prerelease at all unless `--tag` is passed explicitly.

A numeric identifier (`0.2.0-0`) derives the tag `0`, which npm rejects because
it parses as semver. The workflow catches that before the build and tells you to
pass the `dist_tag` input instead.

[rfc7]: https://github.com/npm/rfcs/blob/main/accepted/0007-publish-prerelease.md

### The 1.0.0 blocker

`version:set` refuses to write a `1.x` version, on purpose. npm's range rule is
"allows changes that do not modify the left-most non-zero element", so `^0.1.0`
resolves `>=0.1.0 <0.2.0-0` — patch-only, and the plugin genuinely cannot float
onto an SDK minor it was never built against. At `^1.0.0` that narrowing
disappears and the same caret would admit every future 1.x. Change the
cross-dependency in `scripts/version.mjs` to an exact pin before releasing 1.0.0.

## Conventions

- [Conventional Commits](https://www.conventionalcommits.org/) for commit
  subjects (`feat:`, `fix:`, `chore:`, `docs:`). CI enforces this on the **pull
  request title**, not on the commits in the branch — the repo squash-merges, so
  the PR title is the subject that actually lands on `main` and the individual
  commit messages are discarded by the merge.
- [Semantic Versioning](https://semver.org/). Both packages version together.
- Comments explain *why*, not *what*. Several decisions in this repo look wrong
  until you know the constraint behind them — the inverted allowlist, the absent
  `--strict`, the `user:password` userinfo — and each carries the reason it is
  that way. If you change one, change its reason.

## Regenerating package-lock.json

Always with the platform flags:

```sh
rm -rf node_modules */node_modules package-lock.json
npm install --package-lock-only --os=linux --cpu=x64 --libc=glibc
```

They read as a restriction and are the opposite. `@rollup/rollup-*` declares
`libc: glibc`; macOS has no libc, so a plain `npm install` on a Mac cannot
evaluate that constraint and drops every libc-gated optional from the lockfile
— all 25 rollup binaries, including the Mac's own. `npm ci` on a Linux runner
then installs a rollup with no native binary and tsup dies with "Cannot find
module @rollup/rollup-linux-x64-gnu" (npm/cli#4828). Naming a libc makes npm
evaluate the constraint instead of discarding it, and the lockfile comes out
with every platform in it, macOS included. esbuild is unaffected only because
its platform packages declare no `libc`.

Deleting `node_modules` first is part of it: npm resolves against an existing
tree if it finds one, and will faithfully reproduce the darwin-only mistake.
