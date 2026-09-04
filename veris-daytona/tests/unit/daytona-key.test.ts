import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DAYTONA_API_URL, DELETE_SANDBOXES, canDeleteSandboxes, cannotTeardownWarning, daytonaApiUrl, fetchDaytonaKey,
} from '../../src/daytona-key'

/** What GET /api/api-keys/current returned for the key the trial provisioned with. */
const WRITE_ONLY = { name: 'veris-trial', permissions: ['write:sandboxes'] }

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown } | Error) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const r = handler(String(url), init)
    if (r instanceof Error) throw r
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async json() { return r.body },
      async text() { return JSON.stringify(r.body ?? '') },
    } as Response
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('daytonaApiUrl', () => {
  it('is Daytona`s own default, or DAYTONA_API_URL as the SDK reads it', () => {
    expect(daytonaApiUrl({})).toBe(DAYTONA_API_URL)
    expect(daytonaApiUrl({ DAYTONA_API_URL: 'https://api.example/api/' })).toBe('https://api.example/api')
    expect(daytonaApiUrl({ DAYTONA_SERVER_URL: 'https://old.example/api' })).toBe('https://old.example/api')
  })
})

describe('fetchDaytonaKey', () => {
  it('reads GET /api-keys/current with the key as a bearer token', async () => {
    let seen: { url?: string; auth?: string } = {}
    mockFetch((url, init) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization }
      return { status: 200, body: WRITE_ONLY }
    })
    expect(await fetchDaytonaKey('dtn_key')).toEqual(WRITE_ONLY)
    expect(seen.url).toBe(`${DAYTONA_API_URL}/api-keys/current`)
    expect(seen.auth).toBe('Bearer dtn_key')
  })

  it('is undefined — unknown, not "cannot" — when Daytona will not say', async () => {
    mockFetch(() => ({ status: 401 }))
    expect(await fetchDaytonaKey('k')).toBeUndefined()
    mockFetch(() => new Error('ECONNRESET'))
    expect(await fetchDaytonaKey('k')).toBeUndefined()
    mockFetch(() => ({ status: 200, body: { name: 'x' } }))
    expect(await fetchDaytonaKey('k')).toBeUndefined()
  })

  it('keeps only the string permissions, and tolerates a missing name', async () => {
    mockFetch(() => ({ status: 200, body: { permissions: ['write:sandboxes', 7, DELETE_SANDBOXES] } }))
    expect(await fetchDaytonaKey('k')).toEqual({ name: '', permissions: ['write:sandboxes', DELETE_SANDBOXES] })
  })
})

describe('canDeleteSandboxes', () => {
  it('is three-valued: yes, no, and not known', () => {
    expect(canDeleteSandboxes({ name: 'k', permissions: ['write:sandboxes', DELETE_SANDBOXES] })).toBe(true)
    expect(canDeleteSandboxes(WRITE_ONLY)).toBe(false)
    expect(canDeleteSandboxes(undefined)).toBeUndefined()
  })
})

describe('the warning provision prints before creating a box this key cannot delete', () => {
  // Measured: a key with permissions ["write:sandboxes"] provisions fine and
  // then fails every teardown with a bare "Access denied". The user should
  // learn that before the box exists.
  const w = cannotTeardownWarning(WRITE_ONLY, 30, 60)

  it('names the key, its permissions and the one it lacks', () => {
    expect(w).toContain('"veris-trial"')
    expect(w).toContain('permissions: write:sandboxes')
    expect(w).toContain(`\`${DELETE_SANDBOXES}\``)
  })

  it('says teardown will be refused, and what the box does instead', () => {
    expect(w).toContain('`veris-daytona teardown` will be refused')
    expect(w).toContain('stops after 30 idle minutes')
    expect(w).toContain('deleted 60 minutes after it stops')
  })

  it('says how to fix it, at the page where keys are made', () => {
    expect(w).toContain('https://app.daytona.io/dashboard/keys')
    expect(w).toContain('"delete sandboxes" permission')
  })
})
