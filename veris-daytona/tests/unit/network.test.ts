import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REGISTRY_HOSTS,
  buildNetwork,
  dataPlaneEnv,
  dataPlaneHosts,
  isSafeEnvName,
  twinHosts,
  vendorHosts,
} from '../../src/network'
import { gatewayProxyUrl } from '../../src/gateway'
import type { ServiceInfo } from '../../src/control-plane'

const svc = (over: Partial<ServiceInfo>): ServiceInfo => ({
  name: 'stripe', status: 'ready',
  url: 'https://stripe-abc.twin.veris.ai',
  control_url: 'https://stripe-abc.twin.veris.ai',
  routes: [{ host: 'api.stripe.com' }],
  ...over,
})

const GATEWAY = ['gw.api.veris.ai']

describe('vendorHosts', () => {
  it('collects every route host, sorted and deduped', () => {
    expect(vendorHosts([
      svc({ routes: [{ host: 'api.stripe.com' }, { host: 'files.stripe.com' }] }),
      svc({ name: 'stripe2', routes: [{ host: 'api.stripe.com' }] }),
    ])).toEqual(['api.stripe.com', 'files.stripe.com'])
  })
})

describe('buildNetwork', () => {
  it('ALLOWS the vendor hostnames, so Daytona forwards them to the gateway', () => {
    // Reads backwards until you follow the path. Sandbox traffic goes to
    // Daytona's proxy, which drops anything unlisted and forwards the rest to
    // the gateway. A vendor host that is absent never reaches the gateway and
    // never reaches the twin — it is simply blocked. Allowing it is not a leak,
    // because the gateway, not the allowlist, is what stands between the
    // sandbox and the real vendor.
    const net = buildNetwork({ services: [svc({})], mode: 'strict', gatewayHosts: GATEWAY })
    expect(net.domainAllowList!.split(',')).toContain('api.stripe.com')
  })

  it('allows the gateway itself, and the registries', () => {
    const net = buildNetwork({ services: [svc({})], mode: 'strict', gatewayHosts: GATEWAY })
    const allowed = net.domainAllowList!.split(',')
    expect(allowed).toContain('gw.api.veris.ai')
    expect(allowed).toContain('registry.npmjs.org')
    expect(allowed).toContain('pypi.org')
  })

  it('without the gateway host, nothing could reach the twin at all', () => {
    const net = buildNetwork({ services: [svc({})], mode: 'strict', gatewayHosts: [] })
    expect(net.domainAllowList!.split(',')).not.toContain('gw.api.veris.ai')
  })

  it('drops the registries when asked, for a twin-only sandbox', () => {
    const net = buildNetwork({
      services: [svc({})], mode: 'strict', gatewayHosts: GATEWAY, allowRegistries: false,
    })
    const allowed = net.domainAllowList!.split(',')
    for (const host of DEFAULT_REGISTRY_HOSTS) expect(allowed).not.toContain(host)
    expect(allowed).toContain('api.stripe.com')
  })

  it('splices in the data plane hosts a DSN names', () => {
    const net = buildNetwork({
      services: [svc({ name: 'db', url: 'postgres://u:p@pg-abc.twin.veris.ai:5432/app', env_hint: 'DATABASE_URL', routes: [] })],
      mode: 'strict', gatewayHosts: GATEWAY,
    })
    expect(net.domainAllowList!.split(',')).toContain('pg-abc.twin.veris.ai')
  })

  it('carries the caller`s extra allowances', () => {
    const net = buildNetwork({
      services: [svc({})], mode: 'strict', gatewayHosts: GATEWAY, allowOut: ['internal.corp'],
    })
    expect(net.domainAllowList!.split(',')).toContain('internal.corp')
  })

  it('open mode sets NO allowlist, which is why it is not the default', () => {
    const net = buildNetwork({ services: [svc({})], mode: 'open', gatewayHosts: GATEWAY })
    expect(net.domainAllowList).toBeUndefined()
  })

  it('never sets networkBlockAll, which would also block the twin', () => {
    const net = buildNetwork({ services: [svc({})], mode: 'strict', gatewayHosts: GATEWAY })
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


describe('gatewayProxyUrl', () => {
  it('is http, because Daytona rejects every other scheme', () => {
    // Verified live: `Unsupported outbound proxy scheme "socks5h". Must be http
    // or https` — which is the entire reason the gateway needed a CONNECT
    // listener rather than us pointing Daytona at the SOCKS one.
    expect(gatewayProxyUrl('gw.api.veris.ai:8080', 'v1.abc')).toMatch(/^http:\/\//)
  })

  it('carries the sandbox id as the username, which is the demux key', () => {
    expect(gatewayProxyUrl('gw.api.veris.ai:8080', 'v1.abc'))
      .toBe('http://v1.abc:x@gw.api.veris.ai:8080')
  })

  it('percent-encodes userinfo rather than trusting it to be URL-safe', () => {
    expect(gatewayProxyUrl('gw:8080', 'v1/a b')).toContain('v1%2Fa%20b')
  })
})
