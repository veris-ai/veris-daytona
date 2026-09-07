import { describe, expect, it } from 'vitest'
import {
  buildNetwork,
  dataPlaneEnv,
  dataPlaneHosts,
  directTwinHosts,
  isSafeEnvName,
  twinHosts,
  vendorHosts,
} from '../../src/network'
import { gatewayProxyUrl } from '../../src/gateway'
import { VerisError } from '../../src/errors'
import type { ServiceInfo } from '../../src/control-plane'

const svc = (over: Partial<ServiceInfo>): ServiceInfo => ({
  name: 'stripe', status: 'ready',
  url: 'https://stripe-abc.twin.veris.ai',
  control_url: 'https://stripe-abc.twin.veris.ai',
  routes: [{ host: 'api.stripe.com' }],
  ...over,
})

describe('vendorHosts', () => {
  it('collects every route host, sorted and deduped', () => {
    expect(vendorHosts([
      svc({ routes: [{ host: 'api.stripe.com' }, { host: 'files.stripe.com' }] }),
      svc({ name: 'stripe2', routes: [{ host: 'api.stripe.com' }] }),
    ])).toEqual(['api.stripe.com', 'files.stripe.com'])
  })
})

describe('buildNetwork', () => {
  it('pins Daytona to the gateway address, one /32 per IP', () => {
    expect(buildNetwork({ mode: 'strict', gatewayIps: ['136.64.238.87'] }).params)
      .toEqual({ networkAllowList: '136.64.238.87/32' })
    expect(buildNetwork({ mode: 'strict', gatewayIps: ['136.64.238.87', '34.42.156.165', '136.64.238.87'] }).params)
      .toEqual({ networkAllowList: '136.64.238.87/32,34.42.156.165/32' })
  })

  it('NEVER hands Daytona a hostname list', () => {
    // Measured: a domainAllowList beside outboundProxyUrl turns Daytona's
    // egress into a TLS-inspecting proxy, which rejects the gateway's leaf and
    // answers every vendor call with 502. The vendor hostnames, the gateway
    // host, registries — none of it may reappear as a domain list.
    const params = buildNetwork({ mode: 'strict', gatewayIps: ['136.64.238.87'] }).params as Record<string, unknown>
    expect(params).not.toHaveProperty('domainAllowList')
    expect(params).not.toHaveProperty('networkBlockAll')
  })

  it('open mode sets no allowlist at all', () => {
    expect(buildNetwork({ mode: 'open', gatewayIps: [] }).params).toEqual({})
  })

  it('refuses strict mode when nothing named the gateway address, and says what to do', () => {
    let err: unknown
    try { buildNetwork({ mode: 'strict', gatewayIps: [] }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(VerisError)
    expect((err as VerisError).phase).toBe('credential-mint')
    expect((err as VerisError).message).toContain('gateway_ips')
    expect((err as VerisError).message).toContain("veris.egress: 'open'")
  })

  it('refuses an address that is not IPv4, which Daytona`s CIDR list cannot take', () => {
    expect(() => buildNetwork({ mode: 'strict', gatewayIps: ['2001:db8::1'] })).toThrow(/not IPv4/)
    expect(() => buildNetwork({ mode: 'strict', gatewayIps: ['gw.api.veris.ai'] })).toThrow(/not IPv4/)
    expect(() => buildNetwork({ mode: 'strict', gatewayIps: ['999.1.1.1'] })).toThrow(/not IPv4/)
  })
})

describe('directTwinHosts', () => {
  // A routeless twin (yente) has no hostname for the gateway to intercept, so
  // its own URL is the only way in; it travels through the gateway like any
  // other public host, and this is how a caller learns which hosts those are.
  it('names the twin`s own host for a service with no vendor routes', () => {
    expect(directTwinHosts([
      svc({ name: 'yente', url: 'https://svc.veris.ai/s/t1/yente', control_url: 'https://svc.veris.ai/s/t1/yente', routes: [] }),
    ])).toEqual(['svc.veris.ai'])
  })

  it('does NOT name it for a service the gateway intercepts by hostname', () => {
    expect(directTwinHosts([svc({})])).toEqual([])
  })

  it('ignores a DSN service, which is reached through its data plane', () => {
    expect(directTwinHosts([
      svc({ name: 'db', url: 'postgres://pg.twin.veris.ai:5432/app', control_url: 'https://svc.veris.ai/s/t1/db', routes: [] }),
    ])).toEqual([])
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
    expect(gatewayProxyUrl({ connect_address: 'gw.api.veris.ai:8080', username: 'v1.abc' })).toMatch(/^http:\/\//)
  })

  it('carries the sandbox id as the username, which is the demux key', () => {
    expect(gatewayProxyUrl({ connect_address: 'gw.api.veris.ai:8080', username: 'v1.abc' }))
      .toBe('http://v1.abc:x@gw.api.veris.ai:8080')
  })

  it('percent-encodes userinfo rather than trusting it to be URL-safe', () => {
    expect(gatewayProxyUrl({ connect_address: 'gw:8080', username: 'v1/a b' })).toContain('v1%2Fa%20b')
  })

  it('escapes both authority separators, so a username cannot break out', () => {
    // RFC 3986 3.2.1. ':' would split user from password, '@' would end the
    // userinfo and rewrite the host — the two characters that turn a username
    // into an injection.
    const url = gatewayProxyUrl({ connect_address: 'gw.api.veris.ai:8080', username: 'evil:pass@attacker.test' })
    expect(url).toBe('http://evil%3Apass%40attacker.test:x@gw.api.veris.ai:8080')
    expect(new URL(url).hostname).toBe('gw.api.veris.ai')
  })

  it('produces userinfo containing only characters RFC 3986 permits', () => {
    const url = gatewayProxyUrl({ connect_address: 'gw:8080', username: "v1.a-b_c~d!e'f(g)h*i" })
    const userinfo = url.slice('http://'.length, url.lastIndexOf('@'))
    // unreserved / pct-encoded / sub-delims / ':'
    expect(userinfo).toMatch(/^(?:[A-Za-z0-9\-._~!$&'()*+,;=:]|%[0-9A-Fa-f]{2})*$/)
  })

  it('prefers the gateway`s own URL, which carries the real credentials', () => {
    // The gateway's password is the twin id, not a placeholder. Building our
    // own URL from connect_address would authenticate as nobody.
    const url = 'http://v1.abc:abc@gw.dev.api.veris.ai:8080'
    expect(gatewayProxyUrl({ http_proxy_url: url, connect_address: 'other:9', username: 'v1.abc' }))
      .toBe(url)
  })

  it('validates a supplied URL rather than passing it straight through', () => {
    for (const bad of ['not a url', 'socks5://gw:1080', 'http://gw', 'ftp://gw:21']) {
      expect(() => gatewayProxyUrl({ http_proxy_url: bad, username: 'v1.abc' }), bad)
        .toThrow(/gateway proxy URL|only http or https/)
    }
  })

  it('refuses a malformed address from the control plane', () => {
    // It would otherwise land in a URL and then in every client's proxy config.
    for (const bad of ['', 'gw.api.veris.ai', 'http://gw:8080', 'gw:notaport', 'gw:8080/path', 'a b:80']) {
      expect(() => gatewayProxyUrl({ connect_address: bad, username: 'v1.abc' }), bad).toThrow(/malformed gateway address/)
    }
  })
})
