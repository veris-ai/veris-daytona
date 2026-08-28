// Builds the Daytona network params. Unlike E2B (denyOut/allowOut arrays plus
// an egressProxy object), Daytona takes comma-separated strings and enforces
// them at the runner:
//
//   domainAllowList   deny-all-except, at the network layer. THE guarantee.
//   networkAllowList  the same for CIDRs, for data planes that are IP-shaped.
//   outboundProxyUrl  HTTP(S)_PROXY env vars only — per the SDK's own doc,
//                     "convenience routing, not a security boundary on its own".
//
// Which is why nothing here relies on outboundProxyUrl for safety: the
// fail-closed property comes entirely from the two allowlists, in BOTH the
// transparent and the cooperative tier.
import type { ServiceInfo } from './control-plane'

export type EgressMode = 'strict' | 'open'

/** A service whose `url` is an HTTP endpoint (vs a wire-protocol DSN). */
export const isHttpUrl = (u: string) => /^https?:/.test(u)

/**
 * Vendor hostnames the twin answers for.
 *
 * These are deliberately NOT put on the allowlist. In the transparent tier the
 * kernel redirect catches them before they ever reach the network layer; in
 * the cooperative tier a client that ignores HTTP_PROXY dials them for real —
 * and is blocked, because they are absent here. That block is the whole reason
 * the cooperative tier is honest: Veris's own transport.md warns the env-var
 * approach has "silent gaps", and this is what makes the gap loud.
 *
 * Exported because the receipt and the docs both need to name them.
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
 * veris-proxy deliberately does not intercept registries ("dependency
 * resolution inside the container works as it always did" — transport.md). So
 * they must be reachable, and the honest thing is to name them here where a
 * reader can audit the list, rather than punch a wildcard.
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
  /** Host of the Veris control plane — the in-sandbox proxy fetches routes from it. */
  apiBaseHost: string
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
 * Strict (the default) is deny-all-except: the twin, its data planes, the Veris
 * control plane, and package registries. Vendor hostnames are absent by
 * construction — see vendorHosts() for why that is the point rather than an
 * omission.
 *
 * Open sets no allowlist at all. It exists for debugging and is never the
 * default, because in open mode a client that bypasses the proxy reaches the
 * real vendor and the receipt cannot tell you it happened.
 */
export function buildNetwork(args: BuildNetworkArgs): NetworkParams {
  const { services, mode, apiBaseHost, allowOut = [], allowRegistries = true } = args
  if (mode === 'open') return {}

  const domains = [
    ...twinHosts(services),
    ...dataPlaneHosts(services),
    apiBaseHost,
    ...(allowRegistries ? DEFAULT_REGISTRY_HOSTS : []),
    ...allowOut,
  ].filter((h): h is string => Boolean(h))

  return {
    // NOT networkBlockAll: that blocks everything including the twin, and the
    // allowlist is what Daytona documents as "unbypassable network-layer
    // enforcement". Blocking all and then allowing is not a shape the API
    // offers; a non-empty domainAllowList IS the deny-by-default.
    domainAllowList: [...new Set(domains)].sort().join(','),
  }
}

/** The host portion of a control-plane base URL, for the allowlist. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}
