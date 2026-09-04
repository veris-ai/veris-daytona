import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchReceiptEntry, fetchWatermark, parseRequestsBody } from '../../src/receipt'
import type { ServiceInfo } from '../../src/control-plane'

const svc: ServiceInfo = {
  name: 'stripe', status: 'ready',
  url: 'https://svc.veris.ai/s/t1/stripe',
  control_url: 'https://svc.veris.ai/s/t1/stripe',
  routes: [{ host: 'api.stripe.com' }],
}

/** One row as the twin's trace log serves it. */
const row = (id: number, tier = 'handler') => ({ id, method: 'POST', path: `/v1/charges/${id}`, status: 200, tier })

/**
 * A twin whose log holds `total` rows, served the way the real one does:
 * `limit` capped at 1000, `order`, and `since_id` as a strict watermark. Every
 * query it was asked is recorded, which is the point — the bug was the query
 * that was never sent.
 */
function twin(total: number, opts: { honoursSinceId?: boolean; tiers?: (i: number) => string } = {}) {
  const queries: URLSearchParams[] = []
  const rows = Array.from({ length: total }, (_, i) => row(i + 1, opts.tiers?.(i + 1) ?? 'handler'))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const q = new URL(String(url)).searchParams
    queries.push(q)
    const limit = Math.min(Number(q.get('limit') ?? 50), 1000)
    const since = opts.honoursSinceId === false ? 0 : Number(q.get('since_id') ?? 0)
    const kept = rows.filter((r) => r.id > since)
    const ordered = q.get('order') === 'asc' ? kept : [...kept].reverse()
    const body = JSON.stringify({ requests: ordered.slice(0, limit) })
    return { ok: true, status: 200, async text() { return body } } as Response
  }))
  return queries
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchReceiptEntry reads past the server`s default page', () => {
  // The bug: the call carried no query string at all, so it got the server's
  // default limit=50. A run that made 200 calls reported 50, and said nothing
  // about the other 150.
  it('counts every request, not the first 50', async () => {
    const queries = twin(200)
    const entry = await fetchReceiptEntry(svc)
    expect(entry.requests).toBe(200)
    expect(entry.capped).toBe(false)
    expect(queries[0]!.get('limit')).toBe('1000')
  })

  it('pages until the log runs out', async () => {
    const queries = twin(2500)
    const entry = await fetchReceiptEntry(svc)
    expect(entry.requests).toBe(2500)
    expect(entry.capped).toBe(false)
    expect(queries.length).toBe(3)
    // Each page resumes at the newest id the last one served.
    expect(queries[1]!.get('since_id')).toBe('1000')
    expect(queries[2]!.get('since_id')).toBe('2000')
  })

  it('keeps the newest-first contract even though it pages forwards', async () => {
    twin(1200)
    const entry = await fetchReceiptEntry(svc)
    expect(entry.entries[0]!.id).toBe(1200)
    expect(entry.entries.at(-1)!.id).toBe(1)
  })

  it('reports a count it could not finish as a floor', async () => {
    // MAX_PAGES × 1000 rows. Past that the number is "at least this many",
    // which is a true statement, where the count would be a false one.
    twin(30_000)
    const entry = await fetchReceiptEntry(svc)
    expect(entry.capped).toBe(true)
    expect(entry.requests).toBe(20_000)
  })

  it('is honest rather than wrong against a twin that ignores since_id', async () => {
    // FastAPI drops query parameters it does not declare, so an older twin
    // silently re-serves the same page. The read makes no progress: stop, and
    // say the count is a floor.
    twin(2500, { honoursSinceId: false })
    const entry = await fetchReceiptEntry(svc)
    expect(entry.capped).toBe(true)
    expect(entry.requests).toBe(1000)
  })
})

describe('fetchReceiptEntry counts what the RUN caused', () => {
  it('starts at the watermark, so an attached twin`s earlier traffic is not ours', async () => {
    // The measured case: --sandbox attaches to a twin that already has a log.
    // Everything in it predates the run and belongs to whoever made it.
    const queries = twin(100)
    const entry = await fetchReceiptEntry(svc, 60)
    expect(entry.requests).toBe(40)
    expect(queries[0]!.get('since_id')).toBe('60')
  })

  it('drops our own /veris/* rows, which the twin logs too', async () => {
    // Reading a receipt writes a control-tier row. Counting those makes a
    // receipt read twice report requests the code under test never made —
    // exactly the false green the receipt exists to prevent.
    twin(10, { tiers: (i) => (i > 5 ? 'control' : 'handler') })
    const entry = await fetchReceiptEntry(svc)
    expect(entry.requests).toBe(5)
    expect(entry.entries.every((r) => r.id <= 5)).toBe(true)
  })
})

describe('fetchWatermark', () => {
  it('asks for the newest row alone', async () => {
    const queries = twin(42)
    expect(await fetchWatermark(svc)).toBe(42)
    expect(queries[0]!.get('limit')).toBe('1')
    expect(queries[0]!.get('order')).toBe('desc')
  })

  it('is 0 for an empty log, which reads everything', async () => {
    twin(0)
    expect(await fetchWatermark(svc)).toBe(0)
  })
})

describe('parseRequestsBody', () => {
  it('reports the FULL page size, so paging is not decided on a filtered count', () => {
    // A page holding nothing but control rows is still a full page; treating
    // it as short would stop the read at the wrong place.
    const parsed = parseRequestsBody({ requests: [row(1, 'control'), row(2, 'control'), row(3)] })
    expect(parsed.total).toBe(3)
    expect(parsed.count).toBe(1)
  })

  it('survives a body that is not the trace log', () => {
    expect(parseRequestsBody({}).entries).toEqual([])
    expect(parseRequestsBody(null).entries).toEqual([])
  })
})
