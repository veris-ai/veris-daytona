// Builds the Daytona network params.
//
//   networkAllowList  the Veris gateway's IPv4 address(es), one /32 each, and
//                     nothing else. Enforced at Daytona's runner: a process
//                     that ignores the proxy variables cannot dial out at all.
//   outboundProxyUrl  where Daytona forwards everything: the gateway, which
//                     answers vendor hostnames from the twin and passes public
//                     hosts (registries, git) through untouched.
//
// Together those two are the whole mechanism. Daytona never sees a hostname
// list — see buildNetwork for why that is load-bearing, not a simplification.
import type { ServiceInfo } from './control-plane'
import { VerisError } from './errors'

export type EgressMode = 'strict' | 'open'

/** A service whose `url` is an HTTP endpoint (vs a wire-protocol DSN). */
export const isHttpUrl = (u: string) => /^https?:/.test(u)

/**
 * Vendor hostnames the twin answers for — the ones the gateway intercepts on
 * this sandbox's behalf. Informational: they are what a receipt is about, and
 * they are deliberately NOT handed to Daytona as an allowlist (see buildNetwork).
 */
export function vendorHosts(services: ServiceInfo[]): string[] {
  const hosts = new Set<string>()
  for (const svc of services) {
    for (const r of svc.routes ?? []) hosts.add(r.host)
  }
  return [...hosts].sort()
}

/** Hosts the twin itself lives at — the proxy must reach these or nothing works. */
export function twinHosts(services: ServiceInfo[]): string[] {
  const hosts = new Set<string>()
  for (const svc of services) {
    for (const u of [svc.control_url, svc.url]) {
      if (!u || !isHttpUrl(u)) continue
      try { hosts.add(new URL(u).hostname) } catch { /* skip unparseable */ }
    }
  }
  return [...hosts].sort()
}

/**
 * The twin hosts a sandbox genuinely cannot work without.
 *
 * A service with vendor routes needs nothing here: the code under test dials
 * `api.stripe.com` and the gateway answers it from the twin. A service with NO
 * routes has no vendor hostname to dial — yente is the one that measured it —
 * so its own twin URL is the only way in, and that URL resolves to a host that
 * was absent from every allowlist we built. Measured: the URL `services()`
 * hands you is unreachable from inside the sandbox, so a routeless twin cannot
 * be used at all.
 *
 * Narrow on purpose, and the narrowness is the point. Every http service of a
 * twin shares ONE hostname (`…/s/<twin>/<service>`), and that hostname also
 * serves `/veris/*` — including `/veris/reset`, which clears the log the
 * receipt is read from. Allowing it is a real cost, so it is paid only when a
 * service would otherwise be unreachable. See the note at the top of state.ts.
 */
export function directTwinHosts(services: ServiceInfo[]): string[] {
  return twinHosts(services.filter((s) => isHttpUrl(s.url) && !(s.routes ?? []).length))
}

/**
 * Endpoints of non-HTTP data planes (e.g. the pg-gateway a postgres DSN
 * targets). Handed over rather than intercepted, so they need plain
 * reachability on the allowlist or the data plane silently breaks.
 *
 * DSNs come in every shape — with/without credentials, with/without a trailing
 * path, redis/kafka/mongo, IPv6 in brackets, comma-separated multi-host — so we
 * parse with the URL parser (which handles all of them) and only fall back to a
 * regex for exotic non-URL forms. Every host in a multi-host DSN is allowed.
 */
export function dataPlaneHosts(services: ServiceInfo[]): string[] {
  const hosts = new Set<string>()
  for (const svc of services) {
    if (!svc.url || isHttpUrl(svc.url)) continue
    for (const h of hostsFromDsn(svc.url)) hosts.add(h)
  }
  return [...hosts].sort()
}

function hostsFromDsn(dsn: string): string[] {
  const out: string[] = []
  try {
    const u = new URL(dsn)
    // URL.hostname keeps IPv6 brackets; strip them for the allowlist entry.
    if (u.hostname) out.push(u.hostname.replace(/^\[|\]$/g, ''))
  } catch {
    // Not URL-parseable — fall through to the regex.
  }
  // Multi-host DSNs (mongodb://a:27017,b:27017/db) — the URL parser only sees
  // the first authority, so sweep the raw authority for the rest.
  const authority = dsn.replace(/^[^:]+:\/\//, '').split(/[/?]/)[0] ?? ''
  const afterAt = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  for (const part of afterAt.split(',')) {
    const m = part.match(/^\[?([A-Za-z0-9_.:-]+?)\]?(?::\d+)?$/)
    if (m?.[1] && !/^\d+$/.test(m[1])) out.push(m[1].replace(/^\[|\]$/g, ''))
  }
  return out
}

/**
 * `{ [env_hint]: dsn }` for the twin's non-HTTP data planes — the env the code
 * under test reads (e.g. DATABASE_URL). Sibling of dataPlaneHosts: same field,
 * one derivation, so a new service type changes one place.
 */
export function dataPlaneEnv(services: ServiceInfo[]): Record<string, string> {
  const envs: Record<string, string> = {}
  for (const svc of services) {
    if (!svc.env_hint || !svc.url || isHttpUrl(svc.url)) continue
    // The env NAME comes from the control plane and is injected into every
    // command, so it is shape-checked before use: a response naming PATH,
    // NODE_OPTIONS or BASH_ENV would otherwise steer the sandbox's processes.
    if (!isSafeEnvName(svc.env_hint)) continue
    envs[svc.env_hint] = svc.url
  }
  return envs
}

/** Env names a data-plane hint may claim: conventional SCREAMING_SNAKE, and
 *  never one of the process-controlling variables. */
const PROCESS_CONTROLLING = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'BASH_ENV', 'ENV',
  'PYTHONPATH', 'PYTHONSTARTUP', 'SHELL', 'IFS', 'HOME', 'PROMPT_COMMAND',
])
export function isSafeEnvName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && !PROCESS_CONTROLLING.has(name)
}

export interface BuildNetworkArgs {
  mode: EgressMode
  /** IPv4 addresses the Veris gateway listens on, from the egress credential
   *  (or one DNS lookup of the proxy host on an older control plane). */
  gatewayIps: string[]
}

/** The Daytona create params that decide what the sandbox may reach. */
export interface NetworkParams {
  networkAllowList?: string
}

/** What buildNetwork decided. */
export interface NetworkPlan {
  params: NetworkParams
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

/**
 * Strict (the default) pins the sandbox to the gateway's addresses and nothing
 * else: `networkAllowList` is one /32 per gateway IP. Every hostname the code
 * under test dials — vendor, registry, anything — then travels as a CONNECT
 * through the gateway, which answers vendor hostnames from the twin and passes
 * public hosts through. A client that ignores the proxy variables cannot dial
 * out at all (Daytona blocks it), so it fails closed rather than reaching the
 * real vendor.
 *
 * Why an ADDRESS list and not the hostname list this used to build: measured
 * on Daytona, a `domainAllowList` set beside `outboundProxyUrl` switches its
 * egress proxy into TLS inspection. The client is shown a leaf signed by
 * Daytona's own CA, Daytona opens a second TLS session to the gateway and
 * rejects the Veris-signed leaf it gets back, and every vendor call ends as
 * `502 could not reach upstream host` whatever the sandbox trusts.
 * `networkAllowList` beside the same proxy URL leaves the tunnel untouched.
 * Pinning to the gateway also retires Daytona's 20-domain cap: what may be
 * reached is the gateway's decision, not a list assembled here.
 *
 * Open sets no allowlist at all. Daytona still blocks anything that bypasses
 * the proxy in this mode, so it is not a leak; it is the way to run against a
 * control plane that has not published its gateway addresses.
 */
export function buildNetwork(args: BuildNetworkArgs): NetworkPlan {
  const { mode, gatewayIps } = args
  if (mode === 'open') return { params: {} }
  const ips = [...new Set(gatewayIps)]
  if (!ips.length) {
    throw new VerisError(
      "the control plane did not name the gateway's IP addresses (egress credential " +
      '`gateway_ips`) and the gateway hostname could not be resolved, so the sandbox cannot ' +
      "be pinned to it. Upgrade the control plane, or run with veris.egress: 'open' " +
      '(Daytona still blocks anything that bypasses the proxy).',
      { phase: 'credential-mint' })
  }
  const bad = ips.filter((ip) => !IPV4_RE.test(ip))
  if (bad.length) {
    throw new VerisError(
      `the control plane returned gateway addresses that are not IPv4: ${JSON.stringify(bad)} ` +
      "(Daytona's networkAllowList takes IPv4 CIDRs only)",
      { phase: 'credential-mint' })
  }
  return { params: { networkAllowList: ips.map((ip) => `${ip}/32`).join(',') } }
}
