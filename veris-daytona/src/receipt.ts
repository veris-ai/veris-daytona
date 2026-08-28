// The receipt: what the twin actually received, parsed from each service's
// /veris/requests log — plus the integrity probe that keeps it honest.
import type { Sandbox } from '@daytona/sdk'
import { ReceiptIntegrityError, VerisError } from './errors'
import type { ServiceInfo } from './control-plane'

/** One intercepted request, from the twin's trace log. */
export interface ReceiptRequest {
  method: string
  path: string
  /** null = no response sent (fault hang). */
  status: number | null
}

export interface ReceiptEntry {
  /** Count of intercepted requests (real JSON parse, not a regex). */
  requests: number
  /** The twin service's /veris/* control plane. */
  controlUrl: string
  /** Typed request list, newest first. */
  entries: ReceiptRequest[]
  /** Verbatim /veris/requests body. */
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

export function parseRequestsBody(body: unknown): { count: number; entries: ReceiptRequest[] } {
  const rows = Array.isArray((body as RawRequestsBody)?.requests)
    ? (body as RawRequestsBody).requests!
    : []
  const entries: ReceiptRequest[] = rows.map((r) => {
    const row = r as Record<string, unknown>
    return {
      method: String(row.method ?? ''),
      path: String(row.path ?? ''),
      status: typeof row.status === 'number' ? row.status : null,
    }
  })
  return { count: entries.length, entries }
}

export async function fetchReceiptEntry(svc: ServiceInfo): Promise<ReceiptEntry> {
  const url = `${svc.control_url}/veris/requests`
  const res = await fetch(url)
  const text = await res.text()
  if (!res.ok) {
    throw new VerisError(`could not read receipt for service '${svc.name}' (${res.status})`, {
      phase: 'receipt', responseBody: text.slice(0, 500) })
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch {
    throw new VerisError(`service '${svc.name}' returned a non-JSON receipt body`, {
      phase: 'receipt', responseBody: text.slice(0, 500) })
  }
  const { count, entries } = parseRequestsBody(raw)
  return { requests: count, controlUrl: svc.control_url, entries, raw }
}
