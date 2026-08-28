// Builds the Daytona network params.
//
//   domainAllowList   deny-all-except, enforced at the runner. Verified
//                     transparent: a client that strips every proxy variable
//                     still cannot reach a host directly, so this is a network
//                     boundary and not an env-var convention.
//   outboundProxyUrl  where Daytona forwards allowed traffic. Chained, not
//                     advisory — an unreachable one makes allowed traffic 502.
//
// Together those two are the whole mechanism: the allowlist decides what may
// leave, and the outbound proxy (the Veris gateway) decides what answers.
import type { ServiceInfo } from './control-plane'

export type EgressMode = 'strict' | 'open'

/** A service whose `url` is an HTTP endpoint (vs a wire-protocol DSN). */
export const isHttpUrl = (u: string) => /^https?:/.test(u)

/**
 * Vendor hostnames the twin answers for. These MUST be on the allowlist.
 *
 * That reads backwards until you follow the path: the sandbox's traffic goes to
 * Daytona's proxy, which drops anything not allowlisted and forwards the rest
 * to `outboundProxyUrl` — the Veris gateway. So a vendor host that is absent
 * never reaches the gateway and never reaches the twin; it is simply blocked.
 *
 * Allowing it is not a leak, because the allowlist is not what stands between
 * the sandbox and the real vendor — the gateway is. Verified: with every proxy
 * variable stripped, an allowlisted host is still intercepted rather than
 * dialled directly.
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

/**
 * Package registries and toolchain hosts, allowed by default.
 *
 * A coding sandbox that cannot `npm install` is not a coding sandbox, and
 * registries are not vendors under test, so they must stay reachable. Naming
 * them here keeps the list auditable rather than punching a wildcard.
 *
 * Override wholesale with `veris.allowRegistries: false` plus your own
 * `veris.allowOut`, for a sandbox that should reach nothing but its twin.
 */
export const DEFAULT_REGISTRY_HOSTS: readonly string[] = [
  // JS
  'registry.npmjs.org', 'registry.yarnpkg.com',
  // Python
  'pypi.org', 'files.pythonhosted.org',
  // Go
  'proxy.golang.org', 'sum.golang.org',
  // Rust
  'crates.io', 'static.crates.io', 'index.crates.io',
  // Debian/Ubuntu
  'deb.debian.org', 'security.debian.org', 'archive.ubuntu.com', 'security.ubuntu.com',
  // Source + container hosts the above routinely redirect to
  'github.com', 'codeload.github.com', 'objects.githubusercontent.com',
  'raw.githubusercontent.com', 'ghcr.io',
]

export interface BuildNetworkArgs {
  services: ServiceInfo[]
  mode: EgressMode
  /** The Veris gateway's host, and the canary hostname it answers on. Without
   *  these the sandbox cannot reach the gateway at all. */
  gatewayHosts: string[]
  /** Extra hostnames the caller wants reachable. */
  allowOut?: string[]
  /** Include DEFAULT_REGISTRY_HOSTS. Default true. */
  allowRegistries?: boolean
}

/** The Daytona create params that decide what the sandbox may reach. */
export interface NetworkParams {
  networkBlockAll?: boolean
  domainAllowList?: string
}

/**
 * Strict (the default) is deny-all-except: the vendor hosts the twin answers
 * for, the gateway itself, the twin's data planes, and package registries.
 *
 * Open sets no allowlist at all. It exists for debugging and is never the
 * default: with no allowlist there is nothing forcing traffic at the gateway,
 * and the receipt cannot tell you what slipped past.
 */
export function buildNetwork(args: BuildNetworkArgs): NetworkParams {
  const { services, mode, gatewayHosts, allowOut = [], allowRegistries = true } = args
  if (mode === 'open') return {}

  const domains = [
    ...vendorHosts(services),
    ...gatewayHosts,
    ...dataPlaneHosts(services),
    ...(allowRegistries ? DEFAULT_REGISTRY_HOSTS : []),
    ...allowOut,
  ].filter((h): h is string => Boolean(h))

  return {
    // NOT networkBlockAll: that blocks everything including the gateway, and the
    // allowlist is what Daytona documents as "unbypassable network-layer
    // enforcement". Blocking all and then allowing is not a shape the API
    // offers; a non-empty domainAllowList IS the deny-by-default.
    domainAllowList: [...new Set(domains)].sort().join(','),
  }
}
