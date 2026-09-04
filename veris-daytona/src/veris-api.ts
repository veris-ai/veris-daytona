// The namespaced Veris surface: everything this package adds hangs off
// `sbx.veris`, matching Daytona's own `sbx.fs` / `sbx.process` idiom so a
// future @daytona/sdk minor can never collide with a generic method name.
import type { Sandbox } from '@daytona/sdk'
import type { ControlPlane, ServiceInfo } from './control-plane'
import { fetchReceiptEntry } from './receipt'
import type { Receipt, ReceiptEntry, ReceiptLeak } from './receipt'
import { VerisUntouchedError, VerisError } from './errors'
import { dataPlaneEnv, isHttpUrl } from './network'
import type { EgressMode } from './network'
import { patchBundledCas, probeCanary } from './gateway'
import { fetchManual } from './state'
import { trustPrelude, vendoredTrustEnv } from './trust'

/** Everything needed to answer Veris queries about a live sandbox. */
export interface VerisContext {
  sandbox: Sandbox
  controlPlane: ControlPlane
  environmentId: string
  twinId: string
  egress: EgressMode
  /** The reserved host the canary probe dials to prove the tunnel is live. */
  canaryHost: string
  /** Whether this twin is owned (delete removes it) or attached (caller owns it). */
  ownsTwin: boolean
  /** Newest request id per service when this run began, so a receipt counts
   *  what the run caused rather than what an attached twin already held. Set by
   *  create(); a sandbox rehydrated by get() has none and reads the log from
   *  the start, as the receipt always did. Not persisted in a label on
   *  purpose — the sandbox can rewrite its own labels, and a watermark it
   *  chose would let it hide its own traffic from the receipt. */
  watermarks?: Record<string, number>
}

/** Narrow assertTouched to specific requests. All fields AND together. */
export interface TouchMatcher {
  method?: string
  /** Substring match against the request path. */
  path?: string
  /** Minimum matching requests required (default 1). */
  minRequests?: number
}

export interface VerisApi {
  /** The Veris twin's sandbox id — NOT the Daytona sandbox id. */
  readonly sandboxId: string
  /** The Veris environment the twin was deployed from. Every control-plane
   *  route that acts on a twin is scoped to it, so a caller that wants to talk
   *  to the twin itself needs it and has nowhere else to read it from. */
  readonly environmentId: string
  readonly mode: 'gateway'
  services(): Promise<ServiceInfo[]>
  /** The service's own manual: what it models and how its data is shaped. */
  manual(service: string): Promise<string>
  receipt(): Promise<Receipt>
  receipt(service: string): Promise<ReceiptEntry>
  assertTouched(service: string, match?: TouchMatcher): Promise<void>
  getDataPlaneEnv(): Promise<Record<string, string>>
  getTrustEnv(): Record<string, string>
  /** The same trust variables as a shell `export` prelude, for a caller that
   *  can only prefix a command line. */
  trustPrelude(): string
  /** Append the Veris CA to the CA bundles SDKs ship with them. Run it after
   *  installing dependencies; returns the files it changed. */
  patchBundledCas(): Promise<string[]>
  deliverTo(port: number, opts?: DeliverToOpts): Promise<string>
  deliverTo(url: string | null, opts?: DeliverToOpts): Promise<string | null>
}

export interface DeliverToOpts {
  /** Verify the destination is actually reachable from the twin before
   *  returning, via each service's /veris/client/probe. Default true. */
  probe?: boolean
}

export class VerisApiImpl implements VerisApi {
  constructor(private readonly ctx: VerisContext) {}

  get sandboxId(): string { return this.ctx.twinId }
  get environmentId(): string { return this.ctx.environmentId }
  get mode(): 'gateway' { return 'gateway' }

  services(): Promise<ServiceInfo[]> {
    return this.ctx.controlPlane.services(this.ctx.twinId)
  }

  /** Resolve a service by name. A typo and a service that exists but saw
   *  nothing are different failures, so this throws rather than returning
   *  undefined and letting the caller report an empty result. */
  private async resolveService(service: string): Promise<ServiceInfo> {
    const services = await this.services()
    const svc = services.find((s) => s.name === service)
    if (!svc) {
      throw new VerisError(
        `unknown service '${service}' — the twin has no service by that name (available: ${services.map((s) => s.name).join(', ') || 'none'})`,
        { verisSandboxId: this.ctx.twinId })
    }
    return svc
  }

  async manual(service: string): Promise<string> {
    return fetchManual(await this.resolveService(service))
  }

  receipt(): Promise<Receipt>
  receipt(service: string): Promise<ReceiptEntry>
  async receipt(service?: string): Promise<Receipt | ReceiptEntry> {
    // Prove egress is STILL tunnelled before trusting any count. A receipt read
    // from a sandbox whose egress was detached would be a confident lie, which
    // is worse than no receipt at all.
    await probeCanary(this.ctx.sandbox, this.ctx.canaryHost, this.ctx.twinId)

    if (service !== undefined) {
      const svc = await this.resolveService(service)
      return fetchReceiptEntry(svc, this.watermark(svc.name))
    }

    const services = await this.services()
    const entries = await Promise.all(
      services.filter((s) => isHttpUrl(s.control_url)).map(async (svc) =>
        [svc.name, await fetchReceiptEntry(svc, this.watermark(svc.name))] as const))
    return {
      services: Object.fromEntries(entries),
      mode: 'gateway',
      integrity: 'verified',
      leaks: this.leaks(),
    }
  }

  /**
   * What this receipt cannot see. The gateway relays TCP, so QUIC/HTTP3 and ECH
   * ride around it — named rather than rounded off.
   */
  private leaks(): ReceiptLeak[] {
    return ['udp-quic-possible', 'ech-possible']
  }

  /** Where this service's log was when the run began. 0 reads all of it. */
  private watermark(service: string): number {
    return this.ctx.watermarks?.[service] ?? 0
  }

  async assertTouched(service: string, match?: TouchMatcher): Promise<void> {
    // Throws VerisError (not VerisUntouchedError) for an unknown service — a
    // typo is a different failure from a service that saw zero traffic.
    const entry: ReceiptEntry = await this.receipt(service)
    const need = match?.minRequests ?? 1
    const matched = match
      ? entry.entries.filter((r) =>
          (match.method === undefined || r.method.toUpperCase() === match.method.toUpperCase()) &&
          (match.path === undefined || r.path.includes(match.path)))
      : entry.entries
    if (matched.length < need) {
      const what = match
        ? `matching ${match.method ?? 'ANY'} ${match.path ?? '*'} (${matched.length}/${need})`
        : 'any intercepted requests'
      throw new VerisUntouchedError(
        `service '${service}' saw no ${what} — the code under test never reached it ` +
        `(a green run that skipped its dependency looks identical to a working one)`,
        service, { verisSandboxId: this.ctx.twinId })
    }
  }

  async getDataPlaneEnv(): Promise<Record<string, string>> {
    return dataPlaneEnv(await this.services())
  }

  /** The CA trust vars injected at create, for callers building their own env. */
  getTrustEnv(): Record<string, string> {
    return vendoredTrustEnv()
  }

  /**
   * The same variables as a shell prelude, for a caller that has no env map to
   * fill — anything running a command through a session or a shell it did not
   * build the environment for. Daytona resets SSL_CERT_FILE,
   * REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE and NODE_EXTRA_CA_CERTS to its own CA
   * file inside the sandbox, and that file cannot verify the gateway's leaf, so
   * a command that inherits them fails on certificate validation:
   * `uv sync` dies with "invalid peer certificate: UnknownIssuer".
   *
   *   sbx.process.executeCommand(`${sbx.veris.trustPrelude()} uv sync`)
   */
  trustPrelude(): string {
    return trustPrelude(this.getTrustEnv())
  }

  /**
   * Append the Veris CA to the CA bundles the code under test's own SDKs ship.
   *
   * The variables above reach every client that reads one. stripe-python does
   * not: it passes `verify=stripe.ca_bundle_path`, so the first Stripe call
   * fails with "Could not verify Stripe's SSL certificate" in a sandbox where
   * curl, Node and `requests` all succeed. This patches the file itself, which
   * is the Daytona-shaped version of the veris CLI's --patch-bundled-cas.
   *
   * Call it AFTER installing dependencies — the bundles arrive with them, so
   * there is nothing to patch at create time. Safe to call again; it returns
   * only the files it actually changed.
   */
  patchBundledCas(): Promise<string[]> {
    return patchBundledCas(this.ctx.sandbox)
  }

  /**
   * Point every mocked vendor's callbacks/webhooks at this sandbox.
   *
   * Pass a PORT your app listens on and it resolves the sandbox's own preview
   * URL — the address a vendor would POST to in production. Pass a full URL to
   * use that instead, or null to unregister.
   *
   * One call covers every service: a twin has ONE client, so the control plane
   * fans the destination out to all of them.
   */
  deliverTo(port: number, opts?: DeliverToOpts): Promise<string>
  deliverTo(url: string | null, opts?: DeliverToOpts): Promise<string | null>
  async deliverTo(target: number | string | null, opts: DeliverToOpts = {}): Promise<string | null> {
    const url = typeof target === 'number'
      ? (await this.ctx.sandbox.getPreviewLink(target)).url
      : target
    await this.ctx.controlPlane.updateSandbox(
      this.ctx.environmentId, this.ctx.twinId, { client_base_url: url })
    if (url !== null && opts.probe !== false) await this.probeDelivery(url)
    return url
  }

  /** Ask each service to re-probe the registered destination; throw if none can reach it. */
  private async probeDelivery(url: string): Promise<void> {
    const services = (await this.services()).filter((s) => isHttpUrl(s.control_url))
    if (!services.length) return
    const probes = await Promise.all(services.map(async (svc) => {
      try {
        const res = await fetch(`${svc.control_url}/veris/client/probe`, { method: 'POST' })
        return res.ok ? await res.json() as { answered?: boolean } : null
      } catch { return null }
    }))
    if (!probes.some((p) => p?.answered)) {
      throw new VerisError(
        `no service could reach ${url} — is your app listening on that port inside the Daytona sandbox?`,
        { phase: 'receipt', verisSandboxId: this.ctx.twinId, responseBody: probes })
    }
  }
}
