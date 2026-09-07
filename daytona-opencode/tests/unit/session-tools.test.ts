import { afterEach, describe, expect, it, vi } from 'vitest'
import { verisReceiptTool } from '../../.opencode/plugin/daytona/tools/veris-receipt'
import { verisTwinTool } from '../../.opencode/plugin/daytona/tools/veris-twin'
import { verisControlTool } from '../../.opencode/plugin/daytona/tools/veris-control'
import { VerisApiImpl } from '../../../veris-daytona/src/veris-api'
import { svc, trace } from '../../../veris-daytona/tests/unit/trace-fixture'
vi.mock('../../../veris-daytona/src/gateway', () => ({ probeCanary: vi.fn(), patchBundledCas: vi.fn() }))
const ctx = (sessionID = 'session') => ({ sessionID, metadata: vi.fn(), ask: vi.fn(async () => {}) }) as never
function fixture() {
  const t = trace(100)
  let box = 'box'
  let twin = 'twin'
  let readsFail = false
  const api = () => new VerisApiImpl({
    sandbox: { id: box, sandboxId: box, commands: { run: async () => ({ stdout: JSON.stringify({ veris_sandbox_id: twin }) }) } },
    controlPlane: { services: async () => { if (readsFail) throw new Error('read failed'); return [svc] } },
    twinId: twin, environmentId: 'env', ownsTwin: true, mode: 'gateway', canaryHost: 'canary.invalid', egress: 'open',
  } as never)
  const manager = { repoPath: '/remote/project', getSandbox: vi.fn(async (_sessionId: string) => ({ id: box, sandboxId: box, verisSandboxId: twin, veris: api() })) }
  const args = [manager as never, 'project', '/host/project', {} as never] as const
  return { t, manager, receipt: verisReceiptTool(...args), twinTool: verisTwinTool(...args), control: verisControlTool(...args),
    replace() { box = 'replacement'; twin = 'replacement-twin' }, failReads() { readsFail = true } }
}
afterEach(() => vi.unstubAllGlobals())
describe('native session tools', () => {
  it('keeps provider, remote working directory and lifecycle ownership discoverable', async () => {
    const f = fixture()
    const identity = JSON.parse(await f.twinTool.execute({}, ctx()))
    expect(identity).toMatchObject({ provider: 'daytona', sessionId: 'session', sandboxId: 'box', twinId: 'twin', workingDirectory: '/remote/project', lifecycleOwner: 'plugin', twinOwnership: 'plugin' })
    expect(identity.capabilities.control.resources).toContain('data')
    expect(identity.services[0].controlUrl).toBe(svc.control_url)
    expect(f.manager.getSandbox.mock.calls[0]![0]).toBe('session')
  })
  it('selects current-run entries through a baseline and retains identity on service reads', async () => {
    const f = fixture()
    const before = JSON.parse(await f.receipt.execute({ action: 'baseline' }, ctx()))
    f.t.add('control'); f.t.add('probe'); f.t.add('handler', '/v1/current')
    const after = JSON.parse(await f.receipt.execute({ baseline: before.baseline, service: 'stripe' }, ctx()))
    expect(after).toMatchObject({ twinId: 'twin', sessionId: 'session', scope: 'since-baseline', integrity: 'verified', leaks: ['udp-quic-possible', 'ech-possible'], services: { stripe: { requests: 1, complete: true, countKind: 'exact' } } })
    expect(after.services.stripe.entries[0].path).toBe('/v1/current')
    expect(JSON.parse(await f.receipt.execute({}, ctx())).scope).toBe('cumulative')
  })
  it('refuses foreign session tokens, replacement sessions and resets', async () => {
    const f = fixture()
    const b = JSON.parse(await f.receipt.execute({ action: 'baseline' }, ctx())).baseline
    await expect(f.receipt.execute({ baseline: b }, ctx('other'))).rejects.toThrow(/baseline for this session/)
    f.t.reset()
    await expect(f.receipt.execute({ baseline: b }, ctx())).rejects.toThrow(/baseline invalid/)
    f.replace()
    await expect(f.receipt.execute({ baseline: b }, ctx())).rejects.toThrow(/baseline invalid/)
  })
  it('separates incomplete zero, complete control-only, display truncation and failed reads', async () => {
    const f = fixture()
    const b = JSON.parse(await f.receipt.execute({ action: 'baseline' }, ctx())).baseline
    f.t.add('control')
    expect(JSON.parse(await f.receipt.execute({ baseline: b }, ctx())).services.stripe).toMatchObject({ requests: 0, complete: true })
    for (let i = 0; i < 60; i++) f.t.add()
    const rendered = JSON.parse(await f.receipt.execute({ baseline: b }, ctx()))
    expect(rendered.services.stripe).toMatchObject({ requests: 60, countKind: 'exact', omittedEntries: 10 })
    f.failReads()
    await expect(f.receipt.execute({ baseline: b }, ctx())).rejects.toThrow(/read failed/)
    const capped = trace(21000)
    capped.rows.forEach(r => r.tier = 'control')
    const g = fixture(); trace(21000).rows.forEach(r => r.tier = 'control')
    expect(JSON.parse(await g.receipt.execute({}, ctx())).services.stripe).toMatchObject({ requests: 0, countKind: 'at-least', complete: false })
  })
  it('requires the configured write permission before seeding and never accepts a lifecycle write', async () => {
    const f = fixture()
    const context = ctx() as any
    context.ask.mockRejectedValueOnce(new Error('permission denied'))
    const spy = vi.mocked(fetch)
    await expect(f.control.execute({ service: 'stripe', resource: 'data', method: 'POST', body: { data: { faults: [] } } }, context)).rejects.toThrow(/permission denied/)
    expect(spy).not.toHaveBeenCalled()
    expect(context.ask.mock.calls[0][0]).toMatchObject({ permission: 'verisControlWrite', patterns: ['twin/stripe/data'] })
    await expect(f.control.execute({ service: 'stripe', resource: 'schema', method: 'POST' }, context)).rejects.toThrow(/Only data/)
  })
})
