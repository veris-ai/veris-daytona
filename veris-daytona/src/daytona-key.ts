// What the DAYTONA_API_KEY may do, read from Daytona itself.
//
// A key made with only "write sandboxes" creates boxes it can never delete:
// DELETE /api/sandbox/<id> answers 403, which the SDK surfaces as a bare
// `Access denied` from `sandbox.delete()`, after the box existed and was
// billing. GET /api/api-keys/current says which permissions a key holds, so a
// caller can say up front that deleting will not be possible — before creating
// a box rather than after.
//
// Everything here is best effort. A permissions read that fails must not stop
// a create that would have worked: the answer is a warning, never a gate.

export const DAYTONA_API_URL = 'https://app.daytona.io/api'

/** The permission DELETE /api/sandbox/<id> checks for. */
export const DELETE_SANDBOXES = 'delete:sandboxes'

/** The part of GET /api/api-keys/current this package reads. */
export interface DaytonaKeyInfo {
  name: string
  permissions: string[]
}

/** Where the Daytona API is, resolved the way @daytona/sdk resolves it. */
export function daytonaApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.DAYTONA_API_URL || env.DAYTONA_SERVER_URL || DAYTONA_API_URL).replace(/\/$/, '')
}

/**
 * The key's own record, or undefined when Daytona would not say — a network
 * error, a non-2xx, a body without a permissions list. Undefined means
 * "unknown", and a caller must not read it as "cannot delete".
 */
export async function fetchDaytonaKey(apiKey: string, apiUrl: string = daytonaApiUrl()): Promise<DaytonaKeyInfo | undefined> {
  try {
    const res = await fetch(`${apiUrl}/api-keys/current`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) return undefined
    const body = await res.json() as { name?: unknown; permissions?: unknown }
    if (!Array.isArray(body.permissions)) return undefined
    return {
      name: typeof body.name === 'string' ? body.name : '',
      permissions: body.permissions.filter((p): p is string => typeof p === 'string'),
    }
  } catch {
    return undefined
  }
}

/** True, false, or undefined when the key's permissions are not known. */
export function canDeleteSandboxes(key: DaytonaKeyInfo | undefined): boolean | undefined {
  return key === undefined ? undefined : key.permissions.includes(DELETE_SANDBOXES)
}
