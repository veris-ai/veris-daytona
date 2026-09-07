// Resolve only advertised services and fixed control resources. Lifecycle and
// arbitrary URLs are deliberately absent; the plugin owns the attached twin.
import type { ServiceInfo } from './control-plane'
import { VerisError } from './errors'
export type ControlResource = 'manual' | 'schema' | 'operations' | 'data' | 'requests'
export interface ControlOptions {
  method?: 'GET' | 'POST' | 'PATCH'
  query?: Record<string, string>
  body?: unknown
}
export async function serviceControl(svc: ServiceInfo, resource: ControlResource, options: ControlOptions = {}): Promise<unknown> {
  const method = options.method ?? 'GET'
  if (!['manual', 'schema', 'operations', 'data', 'requests'].includes(resource) ||
      !['GET', 'POST', 'PATCH'].includes(method) || (method !== 'GET' && resource !== 'data') ||
      (method === 'GET' && options.body !== undefined) || !/^https?:\/\//.test(svc.control_url)) {
    throw new VerisError('unsupported service control operation')
  }
  const url = new URL(`${svc.control_url.replace(/\/$/, '')}/veris/${resource}`)
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
  const res = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body) })
  const text = await res.text()
  if (!res.ok) throw new VerisError(`service '${svc.name}' ${method} /veris/${resource} failed (${res.status})`)
  try { return JSON.parse(text) } catch { throw new VerisError(`service '${svc.name}' returned invalid control JSON`) }
}
