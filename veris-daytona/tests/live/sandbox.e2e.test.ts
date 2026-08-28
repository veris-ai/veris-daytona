// Live end-to-end against real Daytona and real Veris. Costs money; needs
// DAYTONA_API_KEY, VERIS_API_KEY, VERIS_ENVIRONMENT_ID.
//
//   npm run test:live -w @veris-ai/daytona
//
// This is the proof that matters. The unit suite checks that we build the right
// parameters; only this checks that the parameters do what we think.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Daytona, ControlPlane, SDK_VERSION, isVerisSandbox } from '../../src/index'
import type { Sandbox } from '@daytona/sdk'

const need = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`${k} is required for the live suite`)
  return v
}

const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY
const VERIS_API_KEY = process.env.VERIS_API_KEY
const VERIS_ENVIRONMENT_ID = process.env.VERIS_ENVIRONMENT_ID
const live = DAYTONA_API_KEY && VERIS_API_KEY && VERIS_ENVIRONMENT_ID ? describe : describe.skip

live('a Veris Daytona sandbox, end to end', () => {
  let daytona: Daytona
  let sandbox: Sandbox
  let twinId: string

  beforeAll(async () => {
    daytona = new Daytona({ apiKey: need('DAYTONA_API_KEY') })
    sandbox = await daytona.create({
      veris: { onSnapshotLogs: (c) => process.stdout.write(`[snapshot] ${c}`) },
    })
    if (!isVerisSandbox(sandbox)) throw new Error('create() returned a sandbox with no Veris surface')
    twinId = sandbox.verisSandboxId
  }, 900_000)

  afterAll(async () => {
    await sandbox?.delete().catch(() => {})
  }, 300_000)

  it('comes up with interception already live', async () => {
    // create() must not resolve before veris-proxy has bound, or the first
    // command of a session could outrun it.
    const r = await sandbox.process.executeCommand('test -f /run/veris/ready && echo READY')
    expect(r.result).toContain('READY')
  })

  it('answers a vendor call from the twin, and the receipt proves it', async () => {
    if (!isVerisSandbox(sandbox)) throw new Error('not a Veris sandbox')
    const services = await sandbox.veris.services()
    const withRoutes = services.find((s) => s.routes?.length)
    expect(withRoutes, 'the twin exposes no routed service to test against').toBeDefined()
    const host = withRoutes!.routes![0]!.host

    await sandbox.process.executeCommand(
      `curl -sS --max-time 30 https://${host}/ -o /dev/null -w '%{http_code}' || true`,
      undefined, undefined, 60,
    )

    // The load-bearing assertion: the TWIN saw it, not just that curl exited 0.
    await sandbox.veris.assertTouched(withRoutes!.name)
  }, 180_000)

  it('is fail-closed: an unmapped host is blocked, not forwarded', async () => {
    // Without this, the receipt above proves less than it looks. A sandbox that
    // can still reach the real internet has an allowlist that is not enforcing.
    const r = await sandbox.process.executeCommand(
      `curl -sS --max-time 20 https://example.com/ -o /dev/null -w '%{http_code}' || echo BLOCKED`,
      undefined, undefined, 40,
    )
    expect(r.result).toContain('BLOCKED')
  }, 120_000)

  it('reports which tier it got, and verifies integrity', async () => {
    if (!isVerisSandbox(sandbox)) throw new Error('not a Veris sandbox')
    const receipt = await sandbox.veris.receipt()
    expect(['transparent', 'cooperative']).toContain(receipt.mode)
    // `veris-proxy check` confirmed the live proxy belongs to THIS run.
    expect(receipt.integrity).toBe('verified')
    console.log(`  tier=${receipt.mode} leaks=${receipt.leaks.join(',') || 'none'}`)
  }, 120_000)

  it('rehydrates the Veris surface through get(), in a fresh client', async () => {
    // THE resumed-session regression. The OpenCode plugin reconnects with
    // get() after any restart; a get() that returned a bare Sandbox would mean
    // no receipts for the rest of that session and a leaked twin on delete.
    const fresh = new Daytona({ apiKey: need('DAYTONA_API_KEY') })
    const again = await fresh.get(sandbox.id)
    expect(isVerisSandbox(again)).toBe(true)
    expect((again as typeof sandbox & { verisSandboxId: string }).verisSandboxId).toBe(twinId)
    const receipt = await (again as Parameters<typeof isVerisSandbox>[0] & {
      veris: { receipt: () => Promise<unknown> }
    }).veris.receipt()
    expect(receipt).toBeDefined()
  }, 180_000)

  it('deletes the twin along with the sandbox, leaking nothing', async () => {
    // Invisible until the bill arrives, so it is asserted rather than assumed.
    // delete() is wrapped by @veris-ai/daytona, which is why the OpenCode
    // plugin needs no teardown code of its own.
    await sandbox.delete()

    const cp = new ControlPlane({
      apiKey: need('VERIS_API_KEY'),
      apiBase: process.env.VERIS_API_BASE ?? 'https://svc.api.veris.ai',
      sdkVersion: SDK_VERSION,
    })
    const twin = await cp.getTwin(twinId)
    expect(twin === null || twin.status === 'terminating').toBe(true)
  }, 300_000)
})
