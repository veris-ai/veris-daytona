// The full path, end to end, printing what it proves at each step.
//
//   export DAYTONA_API_KEY=… VERIS_API_KEY=… VERIS_ENVIRONMENT_ID=…
//   npx tsx scripts/smoke.ts
//
// No image, no snapshot, no in-sandbox proxy: egress is routed through the
// Veris gateway via Daytona's outboundProxyUrl. Cleans up after itself,
// including on failure — a leaked twin bills silently.
import { Daytona, isVerisSandbox } from '@veris-ai/daytona'
import type { Sandbox } from '@veris-ai/daytona'

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
    say('Create a sandbox (provisions the twin, mints the credential, routes egress)')
    info('no image to build: the gateway is host-side, so any image works')
    const t0 = Date.now()
    sandbox = await daytona.create({}, { timeout: 300 })
    if (!isVerisSandbox(sandbox)) throw new Error('create() returned a sandbox with NO Veris surface')
    twinId = sandbox.verisSandboxId
    ok(`Daytona sandbox ${sandbox.id}`)
    ok(`Veris twin      ${twinId}`)
    info(`${Math.round((Date.now() - t0) / 1000)}s`)

    say('Egress is tunnelled through the gateway (create() proved it with the canary)')
    const receipt0 = await sandbox.veris.receipt()
    ok(`mode: ${receipt0.mode}   integrity: ${receipt0.integrity}`)
    if (receipt0.leaks.length) info(`blind spots: ${receipt0.leaks.join(', ')}`)

    say('What does the twin answer for?')
    const services = await sandbox.veris.services()
    for (const s of services) {
      info(`${s.name.padEnd(14)} ${(s.routes ?? []).map((r) => r.host).join(', ') || '(no http routes)'}`)
    }
    const routed = services.find((s) => s.routes?.length)
    if (!routed) throw new Error('this Veris environment exposes no routed HTTP service — nothing to intercept')

    say('Fail-closed: a host the twin does not answer for must be BLOCKED')
    const blocked = await sandbox.process.executeCommand(
      `curl -sS --max-time 20 https://example.com/ -o /dev/null -w 'HTTP %{http_code}' 2>&1 || echo ' BLOCKED'`,
      undefined, undefined, 40)
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
      undefined, undefined, 60)
    info(`curl said: ${called.result?.trim()}`)

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
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m\x1b[1mFAILED\x1b[0m at step ${step}: ${err?.message ?? err}`)
  if (err?.phase) console.error(`  phase: ${err.phase}`)
  if (err?.cause) console.error(`  cause: ${err.cause}`)
  if (err?.responseBody) console.error(`  body:  ${JSON.stringify(err.responseBody).slice(0, 400)}`)
  process.exit(1)
})
