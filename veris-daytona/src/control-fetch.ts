// The one way this package talks to a twin service's /veris/* control plane.
//
// A split sandbox (services-sandbox#1248, #1289) serves its app traffic at
// `url` (…/s/<sandbox>/<svc>) and its control plane at `control_url`
// (…/c/<sandbox>/<svc>), and the control plane takes the same Veris API key the
// /v1 routes do. `/veris/*` on the data URL, or on an intercepted vendor
// hostname, is the VENDOR's 404 there — so control is never probed through
// either; only `control_url` is dialled.
//
// The key is sent ONLY when the service says its control plane takes it
// (`control_auth: "api_key"`), and then only to the origin of that service's
// own control_url, which the authenticated /v1 API handed us. When
// control_auth is null or absent (an older or pinned sandbox, or an API that
// predates the field) control_url is the /s/ data URL — the twin itself, which
// the code under test also talks to — and the key must not go there, so
// nothing is sent. `redirect: 'error'` is forced rather than left to callers,
// because following a redirect would carry the header to whatever host the
// Location names.
import type { ServiceInfo } from './control-plane'
import { InvalidCredentialsError, VerisError } from './errors'

/** What a control call needs to authenticate: the Veris API key, the same one
 *  ControlPlane sends to /v1. */
export interface ControlAuth {
  apiKey: string
}

/** Whether this service's control plane is the keyed kind. */
export function controlNeedsKey(svc: ServiceInfo): boolean {
  return svc.control_auth === 'api_key'
}

/**
 * fetch `path` (starting `/veris/`, query string allowed) on the service's
 * control_url, with the API key when control_auth is "api_key". A 401 becomes InvalidCredentialsError; every
 * other status is returned for the caller to interpret.
 */
export async function controlFetch(
  auth: ControlAuth | undefined, svc: ServiceInfo, path: string, init: RequestInit = {},
): Promise<Response> {
  if (!path.startsWith('/veris/')) throw new VerisError(`not a control path: ${path}`)
  const base = new URL(svc.control_url)
  const url = new URL(`${svc.control_url.replace(/\/$/, '')}${path}`)
  // Concatenation cannot change the origin today; this keeps it that way.
  if (url.origin !== base.origin) throw new VerisError(`control path escapes ${base.origin}: ${path}`)
  const headers = new Headers(init.headers)
  // Never forward a caller-supplied key header to a keyless (data-plane) URL.
  headers.delete('X-API-Key')
  const keyed = controlNeedsKey(svc) && Boolean(auth?.apiKey)
  if (keyed) headers.set('X-API-Key', auth!.apiKey)
  const res = await fetch(url.href, {
    ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000),
  })
  if (res.status === 401) {
    const body = await res.text().catch(() => '')
    throw new InvalidCredentialsError(
      keyed
        ? `the Veris API key was refused by service '${svc.name}' control plane at ${base.origin} (401). ` +
          'Check that VERIS_API_KEY (or veris.apiKey) is valid and belongs to the organization that owns this sandbox.'
        : controlNeedsKey(svc)
          ? `service '${svc.name}' control plane at ${base.origin} requires the Veris API key (401) and none was sent. ` +
            'Pass it, e.g. fetchManual(svc, { apiKey }).'
          : `service '${svc.name}' control plane at ${base.origin} answered 401, but the service does not declare ` +
            'control_auth "api_key", so the Veris API key was not sent to it. Re-read the service from /v1 ' +
            '(the sandbox may have moved to a keyed control plane).',
      { phase: 'credentials', responseBody: body.slice(0, 500) })
  }
  return res
}
