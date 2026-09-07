// The receipt: what the twin actually received, parsed from each service's
// /veris/requests log — plus the integrity probe that keeps it honest.
//
// Two things the log does not hand over for free, and both change the number:
//
//   the page      GET /veris/requests defaults to limit=50 and caps it at
//                 1000. Asking with no query string is asking for 50, so a run
//                 that made 200 calls reported 50 and said nothing about it.
//                 Read here in pages of 1000 until the log runs out.
//   the watermark A twin that was ATTACHED rather than freshly created already
//                 has a log. Counting all of it credits this run with traffic
//                 from before it began, so the read starts at a mark taken
//                 when the run did — see fetchWatermark.
import { VerisError } from './errors'
import type { ServiceInfo } from './control-plane'

/** One intercepted request, from the twin's trace log. */
export interface ReceiptRequest {
  /** Row id. Monotonic per service, and what a later read resumes from. */
  id: number
  method: string
  path: string
  /** null = no response sent (fault hang). */
  status: number | null
  tier: string
}

export interface ReceiptEntry {
  /** Vendor-surface requests the twin received since the watermark. A floor,
   *  not a count, when `capped` is set. */
  requests: number
  /** The twin service's /veris/* control plane. */
  controlUrl: string
  /** Typed request list, newest first. */
  entries: ReceiptRequest[]
  /** The read stopped before the log did, so `requests` is "at least this
   *  many". Never silent: a count that is quietly a floor is exactly the bug
   *  this replaced. */
  capped: boolean
  /** Present when this is only a lower bound. */
  incompleteReason?: string
  sinceId?: number
  untilId?: number
  /** The /veris/requests rows read, verbatim as served, merged across pages. */
  raw: unknown
}

export type ReceiptLeak = 'udp-quic-possible' | 'ech-possible'

export interface Receipt {
  /** Keyed by service name. Partial: indexing an absent service is a type
   *  error to handle, not a runtime TypeError to discover. */
  services: Partial<Record<string, ReceiptEntry>>
  /** How the traffic was moved. One tier now: the Veris gateway. */
  mode: 'gateway'
  /** 'verified' iff the canary probe confirmed egress is still tunnelled
   *  through the gateway and demuxed to THIS twin. */
  integrity: 'verified'
  /** Known blind spots of THIS receipt. */
  leaks: ReceiptLeak[]
}

export interface RawRow extends ReceiptRequest {
  [key: string]: unknown
}
const PAGE_LIMIT = 1000
const MAX_PAGES = 20

/** Malformed reads are failures, never successful empty evidence. */
export function rowsOf(body: unknown): RawRow[] {
  if (!body || !Array.isArray((body as { requests?: unknown }).requests)) {
    throw new VerisError('invalid request log: expected requests array', { phase: 'receipt' })
  }
  const rows = (body as { requests: RawRow[] }).requests
  for (const r of rows) {
    if (!r || !Number.isSafeInteger(r.id) || r.id <= 0 || typeof r.method !== 'string' ||
        typeof r.path !== 'string' || typeof r.tier !== 'string' ||
        !(r.status === null || typeof r.status === 'number')) {
      throw new VerisError('invalid request log row: stable id, method, path, tier and status required', { phase: 'receipt' })
    }
  }
  return rows
}

export function parseRequestsBody(body: unknown): { count: number; entries: ReceiptRequest[]; total: number } {
  const rows = rowsOf(body)
  const entries = rows.filter(r =>
    ['handler', 'fault', 'fallback', 'fallback-llm', 'fallback-replay'].includes(r.tier) &&
    !/^\/veris(?:\/|$)/.test(r.path)
  ).map(({ id, method, path, status, tier }) => ({ id, method, path, status, tier }))
  return { count: entries.length, entries, total: rows.length }
}

export async function readPage(svc: ServiceInfo, query: URLSearchParams): Promise<RawRow[]> {
  const res = await fetch(`${svc.control_url.replace(/\/$/, '')}/veris/requests?${query}`, {
    signal: AbortSignal.timeout(30_000), redirect: 'error',
  })
  const text = await res.text()
  if (!res.ok) throw new VerisError(`could not read receipt for service '${svc.name}' (${res.status})`, { phase: 'receipt' })
  let body: unknown
  try { body = JSON.parse(text) } catch {
    throw new VerisError(`service '${svc.name}' returned a non-JSON receipt body`, { phase: 'receipt' })
  }
  return rowsOf(body)
}

export async function fetchWatermark(svc: ServiceInfo): Promise<number> {
  const rows = await readPage(svc, new URLSearchParams({ limit: '1', order: 'desc' }))
  if (rows.length > 1) throw new VerisError('request log ignored watermark limit', { phase: 'receipt' })
  return rows[0]?.id ?? 0
}

/** Read a finite window. The newest-id snapshot also detects servers that
 * silently cap pages below our requested limit. Never subtract row counts. */
export async function fetchReceiptEntry(svc: ServiceInfo, sinceId = 0): Promise<ReceiptEntry> {
  if (!Number.isSafeInteger(sinceId) || sinceId < 0) throw new VerisError('invalid receipt watermark', { phase: 'receipt' })
  const end = await fetchWatermark(svc)
  if (end < sinceId) throw new VerisError('receipt baseline invalid: log moved backwards; take a new baseline', { phase: 'receipt' })
  const entries: ReceiptRequest[] = []
  const raw: RawRow[] = []
  let mark = sinceId
  let incompleteReason: string | undefined
  for (let page = 0; mark < end; page++) {
    if (page >= MAX_PAGES) { incompleteReason = 'page-limit'; break }
    let rows: RawRow[]
    try {
      rows = await readPage(svc, new URLSearchParams({ limit: String(PAGE_LIMIT), order: 'asc', since_id: String(mark) }))
    } catch (error) {
      if (!raw.length) throw error
      incompleteReason = 'read-failed'; break
    }
    // Duplicate/backwards rows or an ignored cursor/order mean there may be
    // hidden entries. Do not credit that page or call its count exact.
    let previous = mark
    if (!rows.length || rows.some(r => { const bad = r.id <= previous; previous = r.id; return bad })) {
      incompleteReason = 'pagination-not-progressing'; break
    }
    const window = rows.filter(r => r.id <= end)
    raw.push(...window)
    entries.push(...parseRequestsBody({ requests: window }).entries)
    mark = rows[rows.length - 1]!.id
  }
  entries.sort((a, b) => b.id - a.id)
  return { requests: entries.length, controlUrl: svc.control_url, entries,
    sinceId, untilId: end, capped: Boolean(incompleteReason), ...(incompleteReason ? { incompleteReason } : {}), raw: { requests: raw } }
}
