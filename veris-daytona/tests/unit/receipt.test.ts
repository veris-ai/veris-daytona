import { describe, expect, it, afterEach, vi } from 'vitest'
import { fetchReceiptEntry, fetchWatermark, parseRequestsBody } from '../../src/receipt'
import { svc, row, trace } from './trace-fixture'
afterEach(() => vi.unstubAllGlobals())
describe('receipt windows', () => {
  it('paginates more than a default page, with stable ids newest first', async () => {
    const t = trace(2500)
    const e = await fetchReceiptEntry(svc, 60)
    expect(e.requests).toBe(2440)
    expect(e.capped).toBe(false)
    expect(e.entries[0]!.id).toBe(2500)
    expect(e.entries.at(-1)!.id).toBe(61)
    expect(t.queries.some(q => q.get('since_id') === '1060')).toBe(true)
  })
  it('handles a server page cap smaller than requested', async () => {
    trace(240, { cap: 50 })
    expect(await fetchReceiptEntry(svc)).toMatchObject({ requests: 240, capped: false })
  })
  it('excludes controls, reserved paths and marked probes without stopping pagination', async () => {
    const t = trace(1000)
    t.rows.forEach(r => r.tier = 'control')
    t.add('probe'); t.add('handler', '/veris/schema'); t.add('fault')
    expect(await fetchReceiptEntry(svc)).toMatchObject({ requests: 1, capped: false })
  })
  it('distinguishes successful empty/control-only windows from failed and malformed reads', async () => {
    const t = trace()
    expect(await fetchWatermark(svc)).toBe(0)
    expect(await fetchReceiptEntry(svc)).toMatchObject({ requests: 0, capped: false })
    t.add('control')
    expect(await fetchReceiptEntry(svc)).toMatchObject({ requests: 0, capped: false })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 500 })))
    await expect(fetchReceiptEntry(svc)).rejects.toThrow(/could not read/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    await expect(fetchReceiptEntry(svc)).rejects.toThrow(/requests array/)
    expect(() => parseRequestsBody({ requests: [{ method: 'GET' }] })).toThrow(/stable id/)
  })
  it('reports page limits, stalled cursors and interrupted reads as lower bounds', async () => {
    trace(21000)
    expect(await fetchReceiptEntry(svc)).toMatchObject({ requests: 20000, capped: true, incompleteReason: 'page-limit' })
    trace(2500, { ignoreSince: true })
    expect(await fetchReceiptEntry(svc)).toMatchObject({ requests: 1000, capped: true })
    trace(2500, { failPage: 2 })
    expect(await fetchReceiptEntry(svc)).toMatchObject({ requests: 1000, capped: true, incompleteReason: 'read-failed' })
  })
  it('does not credit a backwards/duplicate page or silently accept a rewound log', async () => {
    trace(2500, { ignoreOrder: true })
    expect(await fetchReceiptEntry(svc)).toMatchObject({ requests: 0, capped: true })
    trace(1)
    await expect(fetchReceiptEntry(svc, 10)).rejects.toThrow(/moved backwards/)
  })
  it('excludes prior traffic even when cumulative counts plateau after reset', async () => {
    const t = trace(60)
    const mark = await fetchWatermark(svc)
    t.reset()
    for (let i = 0; i < 60; i++) t.add()
    expect(await fetchReceiptEntry(svc, mark)).toMatchObject({ requests: 60, capped: false })
  })
  it('requires an explicit known application tier', () => {
    expect(parseRequestsBody({ requests: [row(1, 'unknown'), row(2, 'control'), row(3, 'fault')] })).toMatchObject({ count: 1, total: 3 })
  })
})
