// A unique, read-only control request anchors history even across resets
// that preserve numeric ids. No server generation endpoint is assumed.
import { randomUUID } from 'node:crypto'
import { VerisError } from './errors'
import type { ServiceInfo } from './control-plane'
import { readPage } from './receipt'

export interface ReceiptBaseline {
  version: 1
  twinId: string
  sandboxId: string
  services: Record<string, { controlUrl: string; id: number; marker: string }>
}
const HEADER = 'x-veris-receipt-baseline'
function markerOf(row: { [key: string]: unknown }): unknown {
  try {
    const headers = typeof row.request_headers === 'string' ? JSON.parse(row.request_headers) : row.request_headers
    return headers?.[HEADER]
  } catch { return undefined }
}

export async function captureBaseline(twinId: string, sandboxId: string, services: ServiceInfo[]): Promise<ReceiptBaseline> {
  const marks = await Promise.all(services.map(async svc => {
    const marker = randomUUID()
    const res = await fetch(`${svc.control_url.replace(/\/$/, '')}/veris/schema`, {
      headers: { [HEADER]: marker }, signal: AbortSignal.timeout(30_000), redirect: 'error',
    })
    await res.text()
    if (!res.ok) throw new VerisError(`could not establish baseline for '${svc.name}' (${res.status})`, { phase: 'receipt' })
    // Trace middleware commits after sending the response. A bounded retry
    // accommodates that commit without accepting an absent/ambiguous anchor.
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await readPage(svc, new URLSearchParams({ limit: '1000', order: 'desc' }))
      const anchor = rows.find(r => markerOf(r) === marker && r.tier === 'control' && r.path === '/veris/schema')
      if (anchor) return [svc.name, { controlUrl: svc.control_url, id: anchor.id, marker }] as const
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new VerisError(`baseline unavailable for '${svc.name}': trace must retain control request headers`, { phase: 'receipt' })
  }))
  return { version: 1, twinId, sandboxId, services: Object.fromEntries(marks) }
}

export async function validateBaseline(baseline: ReceiptBaseline, twinId: string, sandboxId: string, services: ServiceInfo[]): Promise<void> {
  const invalid = () => new VerisError('receipt baseline invalid: session, services or history changed; take a new baseline before execution', { phase: 'receipt' })
  if (baseline.version !== 1 || baseline.twinId !== twinId || baseline.sandboxId !== sandboxId ||
      Object.keys(baseline.services).sort().join('\0') !== services.map(s => s.name).sort().join('\0')) throw invalid()
  await Promise.all(services.map(async svc => {
    const mark = baseline.services[svc.name]
    if (!mark || mark.controlUrl !== svc.control_url || !Number.isSafeInteger(mark.id) || mark.id <= 0) throw invalid()
    const rows = await readPage(svc, new URLSearchParams({ limit: '1', order: 'asc', since_id: String(mark.id - 1) }))
    if (rows.length !== 1 || rows[0]!.id !== mark.id || markerOf(rows[0]!) !== mark.marker) throw invalid()
  }))
}
