// Run after build. Packs and installs the exact sibling artifacts in a new
// directory: workspace links must not hide a missing entrypoint/dependency.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const provider = JSON.parse(readFileSync('package.json')).name.includes('daytona') ? 'daytona' : 'e2b'
const sdkDir = provider === 'daytona' ? 'veris-daytona' : 'e2b'
const stage = mkdtempSync(join(tmpdir(), `veris-${provider}-pack-`))
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...options })
const tarballs = []
for (const dir of [sdkDir, `${provider}-opencode`]) {
  const [pack] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', stage], { cwd: resolve(dir) }))
  const paths = pack.files.map(f => f.path)
  assert(!paths.some(p => p.includes('node_modules/')))
  assert(pack.size < 1_000_000)
  const required = dir === sdkDir ? ['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts'] :
    ['index', `${provider}/tools/veris-twin`, `${provider}/tools/veris-receipt`, `${provider}/tools/veris-control`, `${provider}/plugins/veris-config`].map(p => `.opencode/plugin/${p}.js`)
  for (const file of required) assert(paths.includes(file), `missing ${file}`)
  if (dir === sdkDir && provider === 'daytona') assert(paths.includes('dist/cli.js'))
  tarballs.push(join(stage, pack.filename))
  console.log(`${pack.name}@${pack.version}: ${pack.files.length} files, ${pack.size} bytes`)
}
writeFileSync(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], { cwd: stage, stdio: 'pipe' })
const installed = join(stage, 'node_modules', '@veris-ai', provider)
const pkg = JSON.parse(readFileSync(join(installed, 'package.json')))
assert.equal(pkg.version, JSON.parse(readFileSync(join(sdkDir, 'package.json'))).version)
const sdk = await import(pathToFileURL(join(installed, 'dist/index.js')))
assert.equal(sdk.SDK_VERSION, pkg.version)
if (provider === 'daytona') {
  assert.equal(pkg.bin['veris-daytona'], './dist/cli.js')
  assert.match(readFileSync(join(installed, 'dist/cli.js'), 'utf8'), /^#!\/usr\/bin\/env node/)
  const cleanEnv = { ...process.env }
  for (const key of Object.keys(cleanEnv)) if (/^(VERIS_|DAYTONA_|E2B_)/.test(key)) delete cleanEnv[key]
  for (const verb of ['provision', 'push', 'exec', 'teardown']) {
    const result = spawnSync(join(stage, 'node_modules/.bin/veris-daytona'), [verb, '--help'], { cwd: stage, env: cleanEnv, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout + result.stderr, new RegExp(`veris-daytona ${verb}`))
    console.log(`clean install: veris-daytona ${verb} --help passed`)
  }
} else assert.equal(pkg.bin, undefined, 'E2B remains SDK-only')
console.log(`PACK_STAGE=${stage}`)
