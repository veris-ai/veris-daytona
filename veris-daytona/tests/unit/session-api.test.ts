import { afterEach, describe, expect, it, vi } from 'vitest'
import { VerisApiImpl } from '../../src/veris-api'
import { svc, trace } from './trace-fixture'
vi.mock('../../src/gateway', () => ({ probeCanary: vi.fn(), patchBundledCas: vi.fn() }))
function api(twinId = 'twin') {
  return new VerisApiImpl({ sandbox: { id: 'box', sandboxId: 'box', commands: { run: async () => ({ stdout: JSON.stringify({ veris_sandbox_id: twinId }) }) } },
    controlPlane: { services: async () => [svc] }, twinId, environmentId: 'env', mode: 'gateway', egress: 'open', canaryHost: 'canary.invalid', ownsTwin: true } as never)
}
afterEach(() => vi.unstubAllGlobals())
describe('SDK run and control interface', () => {
  it('captures before execution and preserves routing integrity and blind spots', async () => {
    const t = trace(70)
    const sdk = api()
    const b = await sdk.receiptBaseline()
    t.add('handler', '/v1/test-run')
    expect(await sdk.receiptSince(b, 'stripe')).toMatchObject({ mode: 'gateway', integrity: 'verified', leaks: ['udp-quic-possible', 'ech-possible'], services: { stripe: { requests: 1, capped: false, entries: [{ path: '/v1/test-run' }] } } })
    t.reset()
    await expect(sdk.receiptSince(b)).rejects.toThrow(/baseline invalid/)
  })
  it('resolves the attached service and rejects arbitrary URLs and lifecycle writes', async () => {
    const f = vi.fn(async (_input: string | URL) => new Response(JSON.stringify({ data: {} })))
    vi.stubGlobal('fetch', f)
    await api().control('stripe', 'data', { method: 'POST', body: { data: { faults: [] } } })
    expect(String(f.mock.calls[0]![0])).toBe('https://twin.invalid/stripe/veris/data')
    await expect(api().control('other', 'data')).rejects.toThrow(/unknown service/)
    await expect(api().control('stripe', '../reset' as never, { method: 'POST' })).rejects.toThrow(/unsupported/)
    await expect(api().control('stripe', 'schema', { method: 'PATCH' })).rejects.toThrow(/unsupported/)
  })
})
