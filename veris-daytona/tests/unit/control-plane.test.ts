import { describe, it, expect, vi, afterEach } from 'vitest'
import { ControlPlane } from '../../src/control-plane'
import { VerisGatewayNotOfferedError } from '../../src/errors'

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const { status, body } = handler(String(url), init)
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return body === undefined ? '' : JSON.stringify(body) },
      async json() { return body },
    } as Response
  }))
}

const cp = () => new ControlPlane({ apiKey: 'k', apiBase: 'https://api.veris.ai', sdkVersion: '2.0.0-alpha.1' })

afterEach(() => vi.unstubAllGlobals())

describe('mintEgressCredential capability probe', () => {
  it('returns null when the endpoint is absent (404) — auto can fall back', async () => {
    mockFetch(() => ({ status: 404 }))
    expect(await cp().mintEgressCredential('env_1', 'sb_1')).toBeNull()
  })
  it('throws VerisGatewayNotOfferedError with min_sdk on a 409', async () => {
    mockFetch(() => ({ status: 409, body: { min_sdk: '2.1.0' } }))
    await expect(cp().mintEgressCredential('env_1', 'sb_1')).rejects.toBeInstanceOf(VerisGatewayNotOfferedError)
  })
  it('returns the credential on 200', async () => {
    mockFetch(() => ({ status: 200, body: { socks_address: 'gw:1080', username: 'u', password: 'p', ca_pem: 'PEM', canary_host: 'c' } }))
    const cred = await cp().mintEgressCredential('env_1', 'sb_1')
    expect(cred?.socks_address).toBe('gw:1080')
  })
  it('sends X-API-Key and X-Veris-SDK headers', async () => {
    let seen: Record<string, string> = {}
    mockFetch((_u, init) => { seen = init.headers as Record<string, string>; return { status: 200, body: { socks_address: 'g', username: 'u', password: 'p', ca_pem: 'x', canary_host: 'c' } } })
    await cp().mintEgressCredential('env_1', 'sb_1')
    expect(seen['X-API-Key']).toBe('k')
    expect(seen['X-Veris-SDK']).toBe('2.0.0-alpha.1')
  })
})

describe('extendTtl tolerates a control plane without the contract', () => {
  it('swallows a 405 (endpoint predates TTL-extend)', async () => {
    mockFetch(() => ({ status: 405 }))
    await expect(cp().extendTtl('env_1', 'sb_1', 20)).resolves.toBeUndefined()
  })
})

describe('createTwin explains a 404 rather than reporting it', () => {
  // The regression: "create sandbox in environment kl833…: 404" sent a user
  // checking their API key and their network before thinking to check that the
  // environment id and the API base name the same control plane. They did not.
  it('names the base and the likely cause', async () => {
    mockFetch(() => ({ status: 404 }))
    await expect(cp().createTwin('env_from_prod')).rejects.toThrow(
      /environment 'env_from_prod' does not exist on https:\/\/api\.veris\.ai/)
    await expect(cp().createTwin('env_from_prod')).rejects.toThrow(
      /VERIS_ENVIRONMENT_ID and VERIS_API_BASE name the same one/)
  })

  it('attributes it to twin-provision', async () => {
    mockFetch(() => ({ status: 404 }))
    await expect(cp().createTwin('env_1')).rejects.toMatchObject({ phase: 'twin-provision' })
  })

  // Other failures keep the generic shape; only 404 gets the special reading.
  it('leaves a 500 alone', async () => {
    mockFetch(() => ({ status: 500, body: { detail: 'boom' } }))
    await expect(cp().createTwin('env_1')).rejects.toThrow(/create sandbox in environment env_1: 500/)
  })
})
