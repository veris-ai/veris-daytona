import { vi } from 'vitest'
export const svc = { name: 'stripe', status: 'ready', url: 'https://twin.invalid/stripe', control_url: 'https://twin.invalid/stripe' }
export const row = (id: number, tier = 'handler', path = `/v1/items/${id}`) => ({ id, method: 'POST', path, status: 200, tier, request_headers: '{}' })
export function trace(count = 0, options: { cap?: number; ignoreSince?: boolean; ignoreOrder?: boolean; failPage?: number } = {}) {
  let rows = Array.from({ length: count }, (_, i) => row(i + 1))
  let lastId = count
  let pages = 0
  const queries: URLSearchParams[] = []
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/veris/schema')) {
      const headers = new Headers(init?.headers)
      rows.push({ ...row(++lastId, 'control', '/veris/schema'), request_headers: JSON.stringify(Object.fromEntries(headers)) })
      return new Response(JSON.stringify({ tables: {} }))
    }
    const q = url.searchParams
    queries.push(q)
    if (q.get('order') === 'asc' && q.get('limit') === '1000' && ++pages === options.failPage) return new Response('unavailable', { status: 503 })
    const mark = options.ignoreSince ? 0 : Number(q.get('since_id') ?? 0)
    const kept = rows.filter(r => r.id > mark)
    const sorted = q.get('order') === 'asc' && !options.ignoreOrder ? kept : [...kept].reverse()
    const limit = Math.min(Number(q.get('limit') ?? 50), options.cap ?? 1000)
    return new Response(JSON.stringify({ requests: sorted.slice(0, limit) }))
  })
  vi.stubGlobal('fetch', fetcher)
  return { fetcher, queries, get rows() { return rows },
    add(tier = 'handler', path?: string) { const r = row(++lastId, tier, path); rows.push(r); return r },
    reset(rewind = false) { rows = []; if (rewind) lastId = 0 },
  }
}
