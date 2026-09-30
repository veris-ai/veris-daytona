// Split sandboxes (services-sandbox#1248, #1289) serve /veris/* at control_url
// (…/c/<sandbox>/<svc>) and require the Veris API key there. Every control call
// must carry it, to that origin only, and a refused key must say so.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { controlFetch } from '../../src/control-fetch'
import { InvalidCredentialsError } from '../../src/errors'
import { fetchManual } from '../../src/state'
import { fetchReceiptEntry, fetchWatermark } from '../../src/receipt'
import { captureBaseline, validateBaseline } from '../../src/run-receipt'
import { serviceControl } from '../../src/service-control'
import { VerisApiImpl } from '../../src/veris-api'
import { ControlPlane } from '../../src/control-plane'
import type { ServiceInfo } from '../../src/control-plane'

vi.mock('../../src/gateway', () => ({ probeCanary: vi.fn(), patchBundledCas: vi.fn() }))

const KEY = 'veris_live_key'
const auth = { apiKey: KEY }
const CONTROL = 'https://svc.dev.api.veris.test'
const split: ServiceInfo = {
  name: 'stripe', status: 'ready', control_auth: 'api_key',
  url: 'https://data.veris.test/s/sbx/stripe',
  control_url: `${CONTROL}/c/sbx/stripe`,
  routes: [{ host: 'api.stripe.com' }],
}

interface Call { url: URL; method: string; key: string | null; redirect?: RequestInit['redirect'] }

/** A split twin: /veris/* answers only on control_url, and only with the key. */
function splitTwin() {
  const calls: Call[] = []
  const rows: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    calls.push({ url, method: init.method ?? 'GET', key: headers.get('x-api-key'), redirect: init.redirect })
    if (url.origin !== CONTROL || !url.pathname.startsWith('/c/sbx/stripe/veris/')) {
      return new Response('{"detail":"Not Found"}', { status: 404 })
    }
    if (headers.get('x-api-key') !== KEY) {
      return new Response('{"detail":"invalid or missing API key"}', { status: 401 })
    }
    const route = url.pathname.slice('/c/sbx/stripe'.length)
    if (route === '/veris/schema') {
      rows.push({ id: rows.length + 1, method: 'GET', path: '/veris/schema', status: 200, tier: 'control',
        request_headers: JSON.stringify(Object.fromEntries(headers)) })
      return new Response('{"tables":{}}')
    }
    if (route === '/veris/requests') {
      const since = Number(url.searchParams.get('since_id') ?? 0)
      const kept = rows.filter(r => (r.id as number) > since)
      const ordered = url.searchParams.get('order') === 'asc' ? kept : [...kept].reverse()
      return new Response(JSON.stringify({ requests: ordered.slice(0, Number(url.searchParams.get('limit') ?? 50)) }))
    }
    if (route === '/veris/client/probe') return new Response('{"answered":true}')
    if (route === '/veris/manual') return new Response('# manual')
    return new Response('{"ok":true}')
  }))
  return calls
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function expectOnlyKeyedControlCalls(calls: Call[]) {
  expect(calls.length).toBeGreaterThan(0)
  for (const c of calls) {
    expect(c.url.origin).toBe(CONTROL)
    expect(c.url.pathname.startsWith('/c/sbx/stripe/veris/')).toBe(true)
    expect(c.key).toBe(KEY)
    expect(c.redirect).toBe('error')
  }
}

describe('control calls carry the Veris API key', () => {
  it('on every standalone control read and write', async () => {
    const calls = splitTwin()
    expect(await fetchManual(split, auth)).toBe('# manual')
    expect(await fetchWatermark(auth, split)).toBe(0)
    await fetchReceiptEntry(auth, split)
    const b = await captureBaseline(auth, 'twin', 'box', [split])
    await validateBaseline(auth, b, 'twin', 'box', [split])
    await serviceControl(auth, split, 'data', { method: 'POST', body: { data: {} } })
    await serviceControl(auth, split, 'requests', { query: { limit: '1' } })
    const routes = new Set(calls.map(c => c.url.pathname.replace('/c/sbx/stripe', '')))
    expect([...routes].sort()).toEqual(['/veris/data', '/veris/manual', '/veris/requests', '/veris/schema'])
    expectOnlyKeyedControlCalls(calls)
  })

  it('on every sbx.veris control call, using the ControlPlane key, never the data or vendor host', async () => {
    const calls = splitTwin()
    const cp = new ControlPlane({ apiKey: KEY, apiBase: 'https://api.veris.test', sdkVersion: 't' })
    vi.spyOn(cp, 'services').mockResolvedValue([split])
    vi.spyOn(cp, 'updateSandbox').mockResolvedValue()
    const veris = new VerisApiImpl({ sandbox: { id: 'box' } as never, controlPlane: cp, twinId: 'twin',
      environmentId: 'env', egress: 'strict', canaryHost: 'canary.invalid', ownsTwin: true })
    await veris.manual('stripe')
    await veris.receipt()
    await veris.receipt('stripe')
    const b = await veris.receiptBaseline()
    await veris.receiptSince(b)
    await veris.control('stripe', 'schema')
    await veris.deliverTo('https://app.example.test')
    expect(calls.some(c => c.url.pathname.endsWith('/veris/client/probe') && c.method === 'POST')).toBe(true)
    expectOnlyKeyedControlCalls(calls)
  })
})

describe('the key stays on the control origin', () => {
  it('refuses to follow redirects, so the header cannot be carried elsewhere', async () => {
    const calls = splitTwin()
    await controlFetch(auth, split, '/veris/manual')
    expect(calls[0]!.redirect).toBe('error')
  })

  it('refuses a path that is not a control path', async () => {
    splitTwin()
    await expect(controlFetch(auth, split, '@evil.test/veris/x')).rejects.toThrow(/not a control path/)
    await expect(controlFetch(auth, split, '/v1/charges')).rejects.toThrow(/not a control path/)
  })

  it('dials control_url even when it and the data url differ in host', async () => {
    const calls = splitTwin()
    await fetchManual(split, auth)
    expect(calls.map(c => c.url.origin)).toEqual([CONTROL])
  })

  // An older/pinned sandbox's control_url is the /s/ data URL — the twin the
  // code under test talks to. The Veris key must never go there.
  it.each([
    ['null', { control_auth: null }],
    ['absent', { control_auth: undefined }],
  ] as const)('sends no key when control_auth is %s, and still works', async (_label, over) => {
    const legacy: ServiceInfo = { ...split, ...over, control_url: 'https://data.veris.test/s/sbx/stripe' }
    if (over.control_auth === undefined) delete legacy.control_auth
    const f = vi.fn(async (u: string, _i?: RequestInit) =>
      new Response(u.endsWith('/veris/manual') ? '# legacy' : '{"ok":true}'))
    vi.stubGlobal('fetch', f)
    expect(await fetchManual(legacy, auth)).toBe('# legacy')
    await serviceControl(auth, legacy, 'data', { method: 'POST', body: { data: {} } })
    // Even a key a caller slipped into the headers is stripped.
    await controlFetch(auth, legacy, '/veris/manual', { headers: { 'X-API-Key': KEY } })
    expect(f).toHaveBeenCalledTimes(3)
    for (const [, init] of f.mock.calls) {
      expect(new Headers(init?.headers).get('x-api-key')).toBeNull()
      expect(init?.redirect).toBe('error')
    }
  })

  it('sends no key through sbx.veris for a keyless service, even though ControlPlane holds one', async () => {
    const legacy: ServiceInfo = { ...split, control_auth: null, control_url: 'https://data.veris.test/s/sbx/stripe' }
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ requests: [], answered: true })))
    vi.stubGlobal('fetch', f)
    const cp = new ControlPlane({ apiKey: KEY, apiBase: 'https://api.veris.test', sdkVersion: 't' })
    vi.spyOn(cp, 'services').mockResolvedValue([legacy])
    vi.spyOn(cp, 'updateSandbox').mockResolvedValue()
    const veris = new VerisApiImpl({ sandbox: { id: 'box' } as never, controlPlane: cp, twinId: 'twin',
      environmentId: 'env', egress: 'strict', canaryHost: 'canary.invalid', ownsTwin: true })
    await veris.receipt('stripe')
    await veris.control('stripe', 'schema')
    await veris.deliverTo('https://app.example.test')
    expect(f.mock.calls.length).toBeGreaterThan(0)
    for (const [, init] of f.mock.calls) expect(new Headers(init?.headers).get('x-api-key')).toBeNull()
  })

  it('names the missing control_auth when a keyless service answers 401', async () => {
    const legacy: ServiceInfo = { ...split, control_auth: null }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"invalid or missing API key"}', { status: 401 })))
    const err = await fetchManual(legacy, auth).catch(e => e)
    expect(err).toBeInstanceOf(InvalidCredentialsError)
    expect(err.message).toMatch(/does not declare control_auth "api_key"/)
  })
})

describe('a 401 from the control plane', () => {
  it('is an InvalidCredentialsError that names the key, not a generic status', async () => {
    splitTwin()
    const err = await fetchManual(split, { apiKey: 'wrong' }).catch(e => e)
    expect(err).toBeInstanceOf(InvalidCredentialsError)
    expect(err.phase).toBe('credentials')
    expect(err.message).toMatch(/Veris API key was refused by service 'stripe'/)
    expect(err.message).toMatch(/VERIS_API_KEY/)
  })

  it('says so when no key was sent at all', async () => {
    splitTwin()
    await expect(fetchManual(split)).rejects.toThrow(/requires the Veris API key \(401\) and none was sent/)
  })

  it('surfaces through receipts and deliverTo instead of being folded into another failure', async () => {
    splitTwin()
    const bad = { apiKey: 'wrong' }
    await expect(fetchReceiptEntry(bad, split)).rejects.toBeInstanceOf(InvalidCredentialsError)
    const cp = new ControlPlane({ apiKey: 'wrong', apiBase: 'https://api.veris.test', sdkVersion: 't' })
    vi.spyOn(cp, 'services').mockResolvedValue([split])
    vi.spyOn(cp, 'updateSandbox').mockResolvedValue()
    const veris = new VerisApiImpl({ sandbox: { id: 'box' } as never, controlPlane: cp, twinId: 'twin',
      environmentId: 'env', egress: 'strict', canaryHost: 'canary.invalid', ownsTwin: true })
    await expect(veris.deliverTo('https://app.example.test')).rejects.toBeInstanceOf(InvalidCredentialsError)
  })
})
