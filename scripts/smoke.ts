// The full path, end to end, printing what it proves at each step.
//
//   export DAYTONA_API_KEY=… VERIS_API_KEY=… VERIS_ENVIRONMENT_ID=…
//   npx tsx scripts/smoke.ts
//
// Builds the sandbox image from snapshot/base/Dockerfile through Daytona's
// server-side builder, so nothing needs publishing to a registry first. Cleans
// up after itself, including on failure — a leaked twin bills silently.
import { Daytona, Image, isVerisSandbox } from '@veris-ai/daytona'
import type { Sandbox } from '@veris-ai/daytona'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCKERFILE = join(HERE, '..', 'snapshot', 'base', 'Dockerfile')

// Reused between runs so iterating costs one sandbox, not one image build.
// SMOKE_FRESH=1 forces a new name, which is what actually exercises
// first-run-in-an-org snapshot registration.
const FRESH = process.env.SMOKE_FRESH === '1'
const SNAPSHOT = FRESH ? `veris-smoke-${Date.now().toString(36)}` : 'veris-smoke-dev'

let step = 0
const say = (msg: string) => console.log(`\n\x1b[1m${++step}. ${msg}\x1b[0m`)
const ok = (msg: string) => console.log(`   \x1b[32m✓\x1b[0m ${msg}`)
const info = (msg: string) => console.log(`   \x1b[2m${msg}\x1b[0m`)

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`\n${name} is not set. This smoke test needs all three:`)
    console.error('  DAYTONA_API_KEY  VERIS_API_KEY  VERIS_ENVIRONMENT_ID\n')
    process.exit(2)
  }
  return v
}

async function main() {
  requireEnv('DAYTONA_API_KEY')
  requireEnv('VERIS_API_KEY')
  requireEnv('VERIS_ENVIRONMENT_ID')

  const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
  let sandbox: Sandbox | undefined
  let twinId = ''

  try {
    say('Create a sandbox (registers the snapshot, provisions the twin, starts the proxy)')
    info(`building from ${DOCKERFILE}`)
    info('first run builds the image server-side — several minutes is normal')
    const t0 = Date.now()
    sandbox = await daytona.create({
      veris: {
        snapshot: SNAPSHOT,
        snapshotImage: Image.fromDockerfile(DOCKERFILE),
        onSnapshotLogs: (c) => {
          // Only the step headers, not 28MB of apt chatter.
          const m = c.match(/#\d+ \[[\d/]+\] (\w+)|Created snapshot \S+ \((\w+)\)/)
          if (m) process.stdout.write(`   \x1b[2m${m[0].slice(0, 90)}\x1b[0m\n`)
        },
      },
    })
    if (!isVerisSandbox(sandbox)) throw new Error('create() returned a sandbox with NO Veris surface')
    twinId = sandbox.verisSandboxId
    ok(`Daytona sandbox ${sandbox.id}`)
    ok(`Veris twin      ${twinId}`)
    info(`${Math.round((Date.now() - t0) / 1000)}s`)

    say('Interception is already live (create() must not resolve before it is)')
    const ready = await sandbox.process.executeCommand('test -f /run/veris/ready && echo READY || echo NOT-READY')
    if (!ready.result?.includes('READY')) throw new Error(`proxy not ready: ${ready.result}`)
    ok('/run/veris/ready exists — nothing could have outrun the proxy')

    say('Which tier did we get?')
    const receipt0 = await sandbox.veris.receipt()
    ok(`tier: ${receipt0.mode}   integrity: ${receipt0.integrity}`)
    if (receipt0.leaks.length) info(`blind spots: ${receipt0.leaks.join(', ')}`)

    say('What does the twin answer for?')
    const services = await sandbox.veris.services()
    for (const s of services) {
      info(`${s.name.padEnd(14)} ${(s.routes ?? []).map((r) => r.host).join(', ') || '(no http routes)'}`)
    }
    const routed = services.find((s) => s.routes?.length)
    if (!routed) throw new Error('this Veris environment exposes no routed HTTP service — nothing to intercept')

    // The interception environment — what a real caller passes to its commands.
    const venv = await sandbox.veris.env()

    say('Fail-closed: a host the twin does not answer for must be BLOCKED')
    const blocked = await sandbox.process.executeCommand(
      `curl -sS --max-time 20 https://example.com/ -o /dev/null -w 'HTTP %{http_code}' 2>&1 || echo ' BLOCKED'`,
      undefined, venv, 40)
    // Blocked can look like several things, and all of them are fine: curl
    // failing outright (DNS gated by the allowlist), or veris-proxy answering
    // 421 in strict mode. What must NOT happen is a 2xx/3xx, which would mean
    // the real example.com answered.
    const reached = /HTTP (2\d\d|3\d\d)/.test(blocked.result ?? '')
    if (reached) {
      throw new Error(`example.com was REACHABLE (${blocked.result?.trim()}) — nothing is enforcing`)
    }
    ok(`unmapped host refused: ${blocked.result?.trim().replace(/\s+/g, ' ').slice(0, 60)}`)

    say(`Call the vendor for real: ${routed.routes![0]!.host}`)
    const host = routed.routes![0]!.host
    const called = await sandbox.process.executeCommand(
      `curl -sS --max-time 30 https://${host}/ -o /dev/null -w 'HTTP %{http_code}' 2>&1 || echo FAILED`,
      undefined, venv, 60)
    info(`curl said: ${called.result?.trim()}`)

    if (called.result?.includes('FAILED') || called.result?.includes('000')) {
      const log = await sandbox.process.executeCommand(
        'sh -lc "tail -30 /run/veris/serve.log; echo ---ENV---; cat /run/veris/env 2>/dev/null | head -20"',
        undefined, undefined, 30).catch(() => ({ result: '(no log)' }))
      console.log(`\n   \x1b[2m--- veris-proxy log ---\n${log.result}\x1b[0m`)
    }

    say('THE RECEIPT — did the twin actually see it?')
    // This is the assertion the whole product exists for. curl exiting 0 above
    // proves nothing on its own; only the twin's own log does.
    await sandbox.veris.assertTouched(routed.name)
    const entry = await sandbox.veris.receipt(routed.name)
    ok(`twin '${routed.name}' received ${entry.requests} request(s):`)
    for (const r of entry.entries.slice(0, 10)) {
      info(`${r.method} ${r.path} -> ${r.status ?? 'no response'}`)
    }

    say('Resumed-session path: get() in a fresh client must rehydrate .veris')
    const fresh = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
    const again = await fresh.get(sandbox.id)
    if (!isVerisSandbox(again)) throw new Error('get() lost the Veris surface — receipts would break after any restart')
    if (again.verisSandboxId !== twinId) throw new Error('get() rehydrated the WRONG twin id')
    ok(`get() rehydrated twin ${again.verisSandboxId} from the sandbox labels`)

    say('Teardown: delete() must remove the twin too')
    await sandbox.delete()
    sandbox = undefined
    const { ControlPlane, SDK_VERSION } = await import('@veris-ai/daytona')
    const cp = new ControlPlane({
      apiKey: process.env.VERIS_API_KEY!,
      apiBase: process.env.VERIS_API_BASE ?? 'https://svc.api.veris.ai',
      sdkVersion: SDK_VERSION,
    })
    const twin = await cp.getTwin(twinId)
    if (twin && twin.status !== 'terminating') throw new Error(`twin ${twinId} SURVIVED the delete — it is leaking`)
    ok('twin is gone — nothing leaked')

    console.log('\n\x1b[32m\x1b[1mEVERYTHING PASSED.\x1b[0m Sandbox creation through Veris interception.\n')
  } finally {
    if (sandbox) {
      console.log('\n\x1b[2mcleaning up after failure…\x1b[0m')
      await sandbox.delete().catch((e) => console.error(`   cleanup failed: ${e}`))
    }
    if (FRESH) await daytona.snapshot.delete(SNAPSHOT).catch(() => {})
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m\x1b[1mFAILED\x1b[0m at step ${step}: ${err?.message ?? err}`)
  if (err?.phase) console.error(`  phase: ${err.phase}`)
  if (err?.cause) console.error(`  cause: ${err.cause}`)
  if (err?.responseBody) console.error(`  body:  ${JSON.stringify(err.responseBody).slice(0, 400)}`)
  process.exit(1)
})
