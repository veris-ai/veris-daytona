import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REGISTRY_HOSTS,
  buildNetwork,
  dataPlaneEnv,
  dataPlaneHosts,
  hostOf,
  isSafeEnvName,
  twinHosts,
  vendorHosts,
} from '../../src/network'
import type { ServiceInfo } from '../../src/control-plane'

const svc = (over: Partial<ServiceInfo>): ServiceInfo => ({
  name: 'stripe', status: 'ready',
  url: 'https://stripe-abc.twin.veris.ai',
  control_url: 'https://stripe-abc.twin.veris.ai',
  routes: [{ host: 'api.stripe.com' }],
  ...over,
})

const API_BASE_HOST = 'svc.api.veris.ai'

describe('vendorHosts', () => {
  it('collects every route host, sorted and deduped', () => {
    expect(vendorHosts([
      svc({ routes: [{ host: 'api.stripe.com' }, { host: 'files.stripe.com' }] }),
      svc({ name: 'stripe2', routes: [{ host: 'api.stripe.com' }] }),
    ])).toEqual(['api.stripe.com', 'files.stripe.com'])
  })
})

describe('buildNetwork', () => {
  it('NEVER allows the vendor hostnames', () => {
    // This is the load-bearing assertion of the whole package. In the
    // transparent tier the redirect catches these before the network layer; in
    // the cooperative tier a client that ignores HTTP_PROXY must be BLOCKED
    // here rather than reaching the real Stripe.
    const net = buildNetwork({ services: [svc({})], mode: 'strict', apiBaseHost: API_BASE_HOST })
    const allowed = net.domainAllowList!.split(',')
    expect(allowed).not.toContain('api.stripe.com')
  })

  it('allows the twin, the control plane and the registries', () => {
    const net = buildNetwork({ services: [svc({})], mode: 'strict', apiBaseHost: API_BASE_HOST })
    const allowed = net.domainAllowList!.split(',')
    expect(allowed).toContain('stripe-abc.twin.veris.ai')
    expect(allowed).toContain(API_BASE_HOST)
    expect(allowed).toContain('registry.npmjs.org')
    expect(allowed).toContain('pypi.org')
  })

  it('drops the registries when asked, for a twin-only sandbox', () => {
    const net = buildNetwork({
      services: [svc({})], mode: 'strict', apiBaseHost: API_BASE_HOST, allowRegistries: false,
    })
    const allowed = net.domainAllowList!.split(',')
    for (const host of DEFAULT_REGISTRY_HOSTS) expect(allowed).not.toContain(host)
    expect(allowed).toContain('stripe-abc.twin.veris.ai')
  })

  it('splices in the data plane hosts a DSN names', () => {
    const net = buildNetwork({
      services: [svc({ name: 'db', url: 'postgres://u:p@pg-abc.twin.veris.ai:5432/app', env_hint: 'DATABASE_URL', routes: [] })],
      mode: 'strict', apiBaseHost: API_BASE_HOST,
    })
    expect(net.domainAllowList!.split(',')).toContain('pg-abc.twin.veris.ai')
  })

  it('carries the caller`s extra allowances', () => {
    const net = buildNetwork({
      services: [svc({})], mode: 'strict', apiBaseHost: API_BASE_HOST, allowOut: ['internal.corp'],
    })
    expect(net.domainAllowList!.split(',')).toContain('internal.corp')
  })

  it('open mode sets NO allowlist, which is why it is not the default', () => {
    const net = buildNetwork({ services: [svc({})], mode: 'open', apiBaseHost: API_BASE_HOST })
    expect(net.domainAllowList).toBeUndefined()
  })

  it('never sets networkBlockAll, which would also block the twin', () => {
    const net = buildNetwork({ services: [svc({})], mode: 'strict', apiBaseHost: API_BASE_HOST })
    expect(net.networkBlockAll).toBeUndefined()
  })
})

describe('twinHosts', () => {
  it('takes hostnames from both url and control_url, skipping non-http', () => {
    expect(twinHosts([
      svc({ url: 'postgres://pg.twin.veris.ai:5432/app', control_url: 'https://ctl.twin.veris.ai' }),
    ])).toEqual(['ctl.twin.veris.ai'])
  })
})

describe('dataPlaneHosts', () => {
  it('parses a plain DSN', () => {
    expect(dataPlaneHosts([svc({ url: 'postgres://u:p@pg.twin.veris.ai:5432/app', routes: [] })]))
      .toEqual(['pg.twin.veris.ai'])
  })

  it('parses every host of a multi-host DSN', () => {
    expect(dataPlaneHosts([svc({ url: 'mongodb://a.twin.veris.ai:27017,b.twin.veris.ai:27017/db', routes: [] })]))
      .toEqual(['a.twin.veris.ai', 'b.twin.veris.ai'])
  })

  it('strips IPv6 brackets', () => {
    expect(dataPlaneHosts([svc({ url: 'redis://[2001:db8::1]:6379', routes: [] })]))
      .toEqual(['2001:db8::1'])
  })

  it('ignores http services, which are intercepted not handed over', () => {
    expect(dataPlaneHosts([svc({})])).toEqual([])
  })
})

describe('dataPlaneEnv', () => {
  it('maps env_hint to the DSN', () => {
    expect(dataPlaneEnv([svc({ url: 'postgres://pg.twin.veris.ai:5432/app', env_hint: 'DATABASE_URL', routes: [] })]))
      .toEqual({ DATABASE_URL: 'postgres://pg.twin.veris.ai:5432/app' })
  })

  it('refuses a control-plane response that tries to steer the sandbox`s processes', () => {
    for (const hint of ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'lowercase', '1BAD']) {
      expect(dataPlaneEnv([svc({ url: 'postgres://x:5432/a', env_hint: hint, routes: [] })])).toEqual({})
    }
  })
})

describe('isSafeEnvName', () => {
  it.each([['DATABASE_URL', true], ['REDIS_URL', true], ['PATH', false], ['HOME', false], ['x', false], ['', false]])(
    '%s -> %s', (name, ok) => expect(isSafeEnvName(name as string)).toBe(ok))
})

describe('hostOf', () => {
  it('extracts a hostname and survives garbage', () => {
    expect(hostOf('https://svc.api.veris.ai')).toBe('svc.api.veris.ai')
    expect(hostOf('not a url')).toBe('')
  })
})
