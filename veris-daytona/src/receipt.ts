// The receipt: what the twin actually received, parsed from each service's
// /veris/requests log — plus the integrity probe that keeps it honest.
import type { Sandbox } from '@daytona/sdk'
import { ReceiptIntegrityError, VerisError } from './errors'
import type { ServiceInfo } from './control-plane'

/** Which tier moved the traffic. They differ in coverage, so the receipt says which. */
export type ProxyTier = 'transparent' | 'cooperative'

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

export type ReceiptLeak = 'udp-quic-possible' | 'ech-possible' | 'non-cooperating-client-blocked'

export interface Receipt {
  /** Keyed by service name. Partial: indexing an absent service is a type
   *  error to handle, not a runtime TypeError to discover. */
  services: Partial<Record<string, ReceiptEntry>>
  /** Which tier produced this receipt — the guarantees differ. */
  mode: ProxyTier
  /** 'verified' iff `veris-proxy check` confirmed the live proxy still belongs
   *  to THIS run. A proxy left over from an earlier run, or one the agent
   *  restarted against a different twin, fails this. */
  integrity: 'verified' | 'unverified'
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

/** Where the entrypoint parks the proxy's own state inside the sandbox. */
export const VERIS_RUN_DIR = '/run/veris'
export const READY_FILE = `${VERIS_RUN_DIR}/ready`
export const ENV_FILE = `${VERIS_RUN_DIR}/env`
/**
 * Where veris-proxy keeps its CA and trust material.
 *
 * Explicit, and it has to be. The proxy installs the kernel redirect as root
 * and THEN drops to uid 14741 before publishing its trust material — so the
 * default of `$HOME/.veris` resolves to /root/.veris and the write fails with
 * EACCES after everything else has already succeeded. This directory is owned
 * by 14741, so the drop does not strand it.
 */
export const CA_DIR = `${VERIS_RUN_DIR}/ca`
/** The uid veris-proxy drops to, and the one the kernel redirect exempts. */
export const PROXY_UID = 14741

/**
 * The integrity probe. `veris-proxy check` asserts that the proxy answering
 * inside this sandbox is the one THIS run started, against THIS twin — its
 * whole reason for existing is that "a proxy left running from an earlier run
 * against a different sandbox would otherwise let a suite pass against the
 * wrong data."
 *
 * Sourcing the env file (which `serve --write-env` wrote) supplies both
 * VERIS_PROXY_URL and VERIS_CANARY, so no token is ever passed on a command
 * line where `ps` could read it.
 */
export async function probeIntegrity(
  sandbox: Sandbox,
  expectedTwinId: string,
): Promise<void> {
  const cmd =
    `set -a; . ${ENV_FILE} 2>/dev/null; set +a; ` +
    `veris-proxy check -quiet && echo __VERIS_OK__ || echo "__VERIS_FAIL__:$?"`
  const r = await sandbox.process
    .executeCommand(`sh -lc ${shellQuote(cmd)}`, undefined, undefined, 60)
    .catch((e: unknown) => ({ exitCode: 1, result: String(e) }))
  if (!r.result?.includes('__VERIS_OK__')) {
    throw new ReceiptIntegrityError(
      `integrity probe failed: the proxy in this Daytona sandbox is not the one this run ` +
      `started against twin ${expectedTwinId} (veris-proxy check said: ` +
      `${(r.result || 'nothing').trim().slice(0, 200)})`,
      { phase: 'canary', verisSandboxId: expectedTwinId })
  }
}

/** Single-quote a string for POSIX sh. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
