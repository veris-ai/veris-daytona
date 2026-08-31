import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchManual, assertHttpControlPlane } from '../../src/state'
import { VerisError } from '../../src/errors'
import type { ServiceInfo } from '../../src/control-plane'

const svc = (over: Partial<ServiceInfo> = {}): ServiceInfo => ({
  name: 'stripe',
  status: 'ready',
  url: 'https://gw.veris.ai/stripe',
  control_url: 'https://twin.veris.ai/stripe',
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

function mockFetch(status: number, body: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    async text() { return body },
  } as Response)))
}

describe('assertHttpControlPlane', () => {
  it('accepts an http control plane', () => {
    expect(() => assertHttpControlPlane(svc())).not.toThrow()
  })
  // A postgres twin is reached by DSN and has no /veris/* surface. Saying that
  // beats letting a fetch of "postgres://…/veris/manual" fail incomprehensibly.
  it('names the service when there is no http control plane', () => {
    expect(() => assertHttpControlPlane(svc({ name: 'db', control_url: 'postgres://h/db' })))
      .toThrow(/service 'db' has no HTTP control plane/)
  })
})

describe('fetchManual', () => {
  it('returns the manual body verbatim', async () => {
    mockFetch(200, '# Stripe twin\n\nAnswers /v1/charges.')
    expect(await fetchManual(svc())).toBe('# Stripe twin\n\nAnswers /v1/charges.')
  })

  it('requests /veris/manual on the control plane', async () => {
    mockFetch(200, 'ok')
    await fetchManual(svc())
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('https://twin.veris.ai/stripe/veris/manual')
  })

  it('attributes a control-plane failure to the twin-state phase', async () => {
    mockFetch(503, 'upstream down')
    await expect(fetchManual(svc())).rejects.toMatchObject({
      phase: 'twin-state',
      responseBody: 'upstream down',
    })
    await expect(fetchManual(svc())).rejects.toBeInstanceOf(VerisError)
  })
})
