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

interface RawRequestsBody { requests?: unknown[] }

/** Rows one read asks for. The server's ceiling; its DEFAULT is 50, which is
 *  what a request with no query string was silently getting. */
const PAGE_LIMIT = 1000

/** Pages one receipt read will walk before calling the count a floor. Twenty
 *  thousand rows is already far past the point where a receipt informs
 *  anyone, and an unbounded read is a way to hang the process asking. */
const MAX_PAGES = 20

/** The tier the twin records our own /veris/* reads under. They are this SDK's
 *  traffic, not the code under test's: counting them makes a receipt read
 *  twice report requests nobody made. */
const CONTROL_TIER = 'control'

interface RawRow {
  id: number
  method: string
  path: string
  status: number | null
  tier: string
}

function toRow(r: unknown): RawRow {
  const row = r as Record<string, unknown>
  return {
    id: typeof row.id === 'number' ? row.id : 0,
    method: String(row.method ?? ''),
    path: String(row.path ?? ''),
    status: typeof row.status === 'number' ? row.status : null,
    tier: String(row.tier ?? ''),
  }
}

function rowsOf(body: unknown): RawRow[] {
  return Array.isArray((body as RawRequestsBody)?.requests)
    ? (body as RawRequestsBody).requests!.map(toRow)
    : []
}

/**
 * One /veris/requests body: the vendor-surface entries, and how many rows the
 * page actually held.
 *
 * `total` counts every row, control tier included, because it is what says
 * whether the page was full. That decision must not be made on a filtered
 * count, or a page holding nothing but our own reads would read as the end of
 * the log.
 */
export function parseRequestsBody(body: unknown): { count: number; entries: ReceiptRequest[]; total: number } {
  const rows = rowsOf(body)
  const entries: ReceiptRequest[] = rows
    .filter((r) => r.tier !== CONTROL_TIER)
    .map(({ id, method, path, status }) => ({ id, method, path, status }))
  return { count: entries.length, entries, total: rows.length }
}

/** GET the service's request log with an explicit query. */
async function readPage(svc: ServiceInfo, query: URLSearchParams): Promise<unknown> {
  const res = await fetch(`${svc.control_url}/veris/requests?${query}`)
  const text = await res.text()
  if (!res.ok) {
    throw new VerisError(`could not read receipt for service '${svc.name}' (${res.status})`, {
      phase: 'receipt', responseBody: text.slice(0, 500) })
  }
  try { return JSON.parse(text) } catch {
    throw new VerisError(`service '${svc.name}' returned a non-JSON receipt body`, {
      phase: 'receipt', responseBody: text.slice(0, 500) })
  }
}

/**
 * The newest request id this service has recorded, or 0 for an empty log.
 *
 * Taken when a run begins and handed back to fetchReceiptEntry as `sinceId`,
 * so the receipt counts what THIS run caused. It matters most for an attached
 * twin — a freshly created one usually answers 0 — but it is taken either way,
 * because a fresh twin's log is not always empty: boot-profile seeding and any
 * read before the run leave rows behind, and none of them is the run's.
 *
 * The read is itself logged by the twin, in the control tier parseRequestsBody
 * drops. The mark it returns therefore sits at or above its own row, which is
 * the correct side to be on.
 */
export async function fetchWatermark(svc: ServiceInfo): Promise<number> {
  const body = await readPage(svc, new URLSearchParams({ limit: '1', order: 'desc' }))
  return rowsOf(body)[0]?.id ?? 0
}

/**
 * Every request this service received after `sinceId`, read in full.
 *
 * Pages forward with `since_id` and `order=asc`, following the newest id seen.
 * A twin that does not serve `since_id` ignores it (FastAPI drops query
 * parameters it does not declare), so every row is filtered client-side too
 * and the answer is right under both: such a twin re-serves the same page, the
 * read makes no progress, and the count is reported as a floor instead of as a
 * wrong number.
 */
export async function fetchReceiptEntry(svc: ServiceInfo, sinceId = 0): Promise<ReceiptEntry> {
  const entries: ReceiptRequest[] = []
  const raw: unknown[] = []
  let mark = sinceId
  let capped = false

  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) { capped = true; break }
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT), order: 'asc' })
    if (mark > 0) query.set('since_id', String(mark))

    const body = await readPage(svc, query)
    const rows = rowsOf(body)
    const { entries: served, total } = parseRequestsBody(body)
    const newest = rows.reduce((n, r) => Math.max(n, r.id), mark)

    entries.push(...served.filter((r) => r.id > mark))
    raw.push(...(Array.isArray((body as RawRequestsBody)?.requests) ? (body as RawRequestsBody).requests! : []))

    // A short page is the end of the log, whatever ids were in it.
    if (total < PAGE_LIMIT) break
    // A full page that moved the mark nowhere means the twin ignored the
    // watermark and will keep serving these same rows. Stop, and say so.
    if (newest <= mark) { capped = true; break }
    mark = newest
  }

  // Ascending while paging, newest first in the contract. Sorted rather than
  // reversed, because a twin that ignored `order` served them the other way.
  entries.sort((a, b) => b.id - a.id)
  return { requests: entries.length, controlUrl: svc.control_url, entries, capped, raw: { requests: raw } }
}
