#!/usr/bin/env node
// Bump both packages in lockstep, and the cross-dependency with them.
//
// They version together, and npm will not do the second half for you: bumping
// @veris-ai/daytona to 0.2.0 while the plugin still asks for ^0.1.0 publishes a
// plugin that resolves an SDK it was never built against.
//
//   node scripts/version.mjs 0.2.0
import { readFileSync, writeFileSync } from 'node:fs'

const next = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next ?? '')) {
  console.error('usage: node scripts/version.mjs <semver>   e.g. 0.2.0, 1.0.0-rc.1')
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

console.log(`both packages -> ${next} (plugin now depends on ^${next})`)
console.log('next: update CHANGELOG.md, commit, tag v' + next + ', then `npm run release`')
