// Reads of a twin service's own control plane that are not the receipt.
//
// Same shape and same reasoning as receipt.ts: these run HOST-SIDE, never from
// inside the sandbox. The twin's control routes take the org's API key, which
// the sandbox never holds: a sandbox that could reach /veris/reset could clear
// the request history and make its own receipt say anything.
//
// "Wherever it can be" is the honest version. A service with no vendor routes
// has no hostname for the gateway to intercept, so its twin URL is the only way
// to use it at all; network.ts's directTwinHosts names that host for exactly
// those services, so a caller knows which twins are reached that way.
import { VerisError } from './errors'
import type { ServiceInfo } from './control-plane'
import { isHttpUrl } from './network'

/** Guard shared by every control-plane read: a DSN-only service (postgres and
 *  friends) has no /veris/* surface, and saying so beats a TypeError. */
export function assertHttpControlPlane(svc: ServiceInfo): void {
  if (!svc.control_url || !isHttpUrl(svc.control_url)) {
    throw new VerisError(
      `service '${svc.name}' has no HTTP control plane, so there is nothing to read`,
      { phase: 'twin-state' },
    )
  }
}

/**
 * The service's manual: what this twin models, which endpoints it answers, and
 * the conventions its data follows. Prose, not JSON — it is written to be read
 * before designing anything against the service.
 */
export async function fetchManual(svc: ServiceInfo): Promise<string> {
  assertHttpControlPlane(svc)
  const res = await fetch(`${svc.control_url}/veris/manual`)
  const text = await res.text()
  if (!res.ok) {
    throw new VerisError(`could not read the manual for service '${svc.name}' (${res.status})`, {
      phase: 'twin-state', responseBody: text.slice(0, 500) })
  }
  return text
}
