// Reads of a twin service's own control plane that are not the receipt.
//
// Same shape and same reasoning as receipt.ts: these run HOST-SIDE, never from
// inside the sandbox. A sandbox that can reach /veris/* can also reach
// /veris/reset — and an agent that can clear request history can make its own
// receipt say anything. The twin's host used to be kept off the sandbox's
// Daytona allowlist for that reason; with Daytona pinned to the gateway's
// address instead (see network.ts) the twin's public URL passes through the
// gateway like any other public host. On an older sandbox the data plane's
// /veris/* routes take no key (measured: GET /veris/requests and POST
// /veris/reset both 200 with no credential); a split sandbox moves them to
// control_url and requires the Veris API key, which the sandbox never holds
// (control-fetch.ts). For the older kind, keeping the control routes out of
// the sandbox's reach is the platform's job, not this package's — the same
// position @veris-ai/e2b has always been in. directTwinHosts names the twins a
// sandbox must reach by their own URL (no vendor routes to intercept).
import { VerisError } from './errors'
import type { ServiceInfo } from './control-plane'
import { isHttpUrl } from './network'
import { controlFetch } from './control-fetch'
import type { ControlAuth } from './control-fetch'

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
 *
 * `auth` carries the Veris API key. A split sandbox's control plane refuses a
 * call without it (InvalidCredentialsError); an older one ignores it.
 */
export async function fetchManual(svc: ServiceInfo, auth?: ControlAuth): Promise<string> {
  assertHttpControlPlane(svc)
  const res = await controlFetch(auth, svc, '/veris/manual')
  const text = await res.text()
  if (!res.ok) {
    throw new VerisError(`could not read the manual for service '${svc.name}' (${res.status})`, {
      phase: 'twin-state', responseBody: text.slice(0, 500) })
  }
  return text
}
