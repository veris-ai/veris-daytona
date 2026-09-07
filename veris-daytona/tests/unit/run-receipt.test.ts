import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureBaseline, validateBaseline } from '../../src/run-receipt'
import { svc, trace } from './trace-fixture'
afterEach(() => vi.unstubAllGlobals())
describe('baseline history and identity', () => {
  it('anchors an empty log using a read-only control marker before execution', async () => {
    const t = trace()
    const b = await captureBaseline('twin', 'box', [svc])
    expect(b.services.stripe!.id).toBe(1)
    expect(t.rows[0]!.tier).toBe('control')
    t.add()
    await expect(validateBaseline(b, 'twin', 'box', [svc])).resolves.toBeUndefined()
  })
  it.each([false, true])('rejects reset even when IDs %s rewind and counts recover', async rewind => {
    const t = trace(4)
    const b = await captureBaseline('twin', 'box', [svc])
    t.reset(rewind)
    for (let i = 0; i < 10; i++) t.add()
    await expect(validateBaseline(b, 'twin', 'box', [svc])).rejects.toThrow(/baseline invalid/)
  })
  it('rejects twin, sandbox, service-set and endpoint replacement', async () => {
    trace()
    const b = await captureBaseline('twin', 'box', [svc])
    for (const [twin, box, services] of [
      ['new', 'box', [svc]], ['twin', 'new', [svc]], ['twin', 'box', []],
      ['twin', 'box', [{ ...svc, control_url: 'https://replacement.invalid' }]],
    ] as const) await expect(validateBaseline(b, twin, box, [...services])).rejects.toThrow(/baseline invalid/)
  })
  it('does not turn failed anchor reads into empty evidence', async () => {
    trace()
    const b = await captureBaseline('twin', 'box', [svc])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 503 })))
    await expect(validateBaseline(b, 'twin', 'box', [svc])).rejects.toThrow(/could not read/)
  })
  it('refuses a service that does not retain the marker headers', async () => {
    const t = trace()
    vi.stubGlobal('fetch', vi.fn(async (u, init) => {
      const res = await t.fetcher(u, init)
      t.rows.forEach(r => r.request_headers = '{}')
      return res
    }))
    await expect(captureBaseline('twin', 'box', [svc])).rejects.toThrow(/trace must retain/)
  })
})
