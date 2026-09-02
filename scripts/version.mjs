#!/usr/bin/env node
// Bump both packages in lockstep, and the cross-dependency with them.
//
// They version together, and npm will not do the second half for you: bumping
// @veris-ai/daytona to 0.2.0 while the plugin still asks for ^0.1.0 publishes a
// plugin that resolves an SDK it was never built against.
//
//   node scripts/version.mjs 0.2.0
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const next = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next ?? '')) {
  console.error('usage: node scripts/version.mjs <semver>   e.g. 0.2.0, 1.0.0-rc.1')
  process.exit(2)
}

// The caret below is only safe while we are pre-1.0. npm's range rule is
// "allows changes that do not modify the left-most non-zero element", so
// ^0.1.0 resolves >=0.1.0 <0.2.0-0 -- patch-only, and the plugin genuinely
// cannot float onto an SDK minor it was never built against. At ^1.0.0 that
// narrowing disappears and the same line would admit every future 1.x.
//
// So the first 1.0.0 needs the cross-dependency changed to an exact pin (or a
// tilde) below before this script may write it. Refuse until someone has.
if (Number(next.split('.')[0]) >= 1) {
  console.error(
    `refusing to write ${next}: the plugin's dependency on @veris-ai/daytona is a caret ` +
      `range, which only pins a patch range below 1.0.0. Change it to an exact pin in ` +
      `this script before releasing 1.x.`,
  )
  process.exit(2)
}

const edit = (path, fn) => {
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  fn(pkg)
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
  return pkg.name
}

edit('veris-daytona/package.json', (p) => { p.version = next })
edit('daytona-opencode/package.json', (p) => {
  p.version = next
  p.dependencies['@veris-ai/daytona'] = `^${next}`
})

// package-lock.json carries both workspace versions and the cross-dependency
// range, and nothing above updates it. A stale lock does not fail here or in
// review -- it fails in the release run, at `npm ci`, which refuses a lock that
// disagrees with a package.json. Cheaper to keep them in step than to find out
// mid-release. --package-lock-only touches no node_modules; --ignore-scripts
// because regenerating a lock should not run anyone's install hooks.
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
  stdio: ['ignore', 'ignore', 'inherit'],
})

console.log(`both packages -> ${next} (plugin now depends on ^${next}), lockfile updated`)
console.log('next: open a PR. Once it is merged, publish a GitHub release tagged')
console.log(`      v${next} with "Generate release notes" ticked -- that runs the release`)
console.log('      workflow, which publishes both packages to npm.')
