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
import { probeCanary } from './gateway'
import { fetchManual } from './state'
import { vendoredTrustEnv } from './trust'

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
  readonly mode: 'gateway'
  services(): Promise<ServiceInfo[]>
  /** The service's own manual: what it models and how its data is shaped. */
  manual(service: string): Promise<string>
  receipt(): Promise<Receipt>
  receipt(service: string): Promise<ReceiptEntry>
  assertTouched(service: string, match?: TouchMatcher): Promise<void>
  getDataPlaneEnv(): Promise<Record<string, string>>
  getTrustEnv(): Record<string, string>
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

    if (service !== undefined) return fetchReceiptEntry(await this.resolveService(service))

    const services = await this.services()
    const entries = await Promise.all(
      services.filter((s) => isHttpUrl(s.control_url)).map(async (svc) => [svc.name, await fetchReceiptEntry(svc)] as const))
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
