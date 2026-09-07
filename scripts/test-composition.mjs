// Run with Bun, the OpenCode plugin runtime, against the clean installation
// reported by test:packages. The skills tarball is installed separately into it.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const stage = process.env.VERIS_PACK_STAGE
if (!stage) throw new Error('Set VERIS_PACK_STAGE to the clean install from npm run test:packages')
process.env.XDG_DATA_HOME = join(stage, 'xdg')
const provider = JSON.parse(readFileSync('package.json')).name.includes('daytona') ? 'daytona' : 'e2b'
const providerDir = join(stage, 'node_modules/@veris-ai', `${provider}-opencode`)
const skillsDir = join(stage, 'node_modules/@veris-ai/veris-opencode')
const providerManifest = JSON.parse(readFileSync(join(providerDir, 'package.json')))
const skillsManifest = JSON.parse(readFileSync(join(skillsDir, 'package.json')))
assert.equal(skillsManifest.name, '@veris-ai/veris-opencode')
const load = path => import(pathToFileURL(resolve(path)).href)
const providerPlugin = (await load(join(providerDir, providerManifest.main))).default
const skillsPlugin = (await load(join(skillsDir, 'index.js'))).default
const ctx = { project: { id: 'fixture', worktree: stage }, worktree: stage, directory: stage,
  client: { tui: { showToast: async () => {} } } }
// Presence checks use placeholders; no provider methods execute in this test.
for (const key of ['VERIS_API_KEY', 'VERIS_ENVIRONMENT_ID', 'DAYTONA_API_KEY', 'E2B_API_KEY']) process.env[key] = 'fixture-only'
const providerHooks = await providerPlugin(ctx)
const skillsHooks = await skillsPlugin(ctx)
for (const hooks of [[providerHooks, skillsHooks], [skillsHooks, providerHooks]]) {
  const cfg = { permission: { verisControlWrite: 'deny', veris_reset_sandbox: 'deny' },
    command: { custom: { template: 'user' } }, skills: { paths: ['/user/skills'] },
    mcp: { veris: { type: 'remote', url: 'https://user.invalid/mcp' } } }
  for (const h of hooks) await h.config?.(cfg)
  const tools = Object.assign({}, ...hooks.map(h => h.tool))
  assert.equal(cfg.mcp.veris.url, 'https://user.invalid/mcp')
  assert.equal(cfg.permission.verisControlWrite, 'deny')
  assert.equal(cfg.permission.veris_reset_sandbox, 'deny')
  assert.equal(cfg.permission.veris_create_sandbox, 'deny')
  assert.deepEqual(cfg.skills.paths, ['/user/skills'])
  for (const name of ['bash', 'read', 'write', 'edit', 'multiedit', 'ls', 'glob', 'grep']) assert.equal(tools[name], providerHooks.tool[name])
  for (const name of ['verisTwin', 'verisReceipt', 'verisControl', 'verisSkill']) assert(tools[name])
  for (const command of ['setup', 'build', 'fix']) {
    const template = cfg.command[`veris:${command}`].template
    assert.match(template, /verisSkill/)
    assert.doesNotMatch(template, /!`|(?:^|\s)@|\/Users\/|\/tmp\//)
    const asset = JSON.parse(await tools.verisSkill.execute({ path: `${command}/SKILL.md` }, { sessionID: 'fixture-session' }))
    assert.equal(asset.session_id, 'fixture-session')
    assert.equal(asset.content, readFileSync(join(skillsDir, 'skills', command, 'SKILL.md'), 'utf8'))
  }
  for (const path of ['veris-reference/session.md', 'veris-reference/scripts/record.sh', 'veris-reference/scripts/ledger.sh']) {
    const resource = JSON.parse(await tools.verisSkill.execute({ path }, { sessionID: 'fixture-session' }))
    assert.equal(resource.sha256, createHash('sha256').update(resource.content).digest('hex'))
    assert.equal(resource.content, readFileSync(join(skillsDir, 'skills', path), 'utf8'))
  }
}
console.log(`Packed composition passed in both orders: ${providerManifest.name}@${providerManifest.version} + ${skillsManifest.name}@${skillsManifest.version}`)
console.log('Offline hook/resource/config check only; no application, provider lifecycle or synchronization ran live.')
