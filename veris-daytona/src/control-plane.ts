// Typed client for the Veris control plane (svc.api.veris.ai). Only the routes
// the SDK needs; shapes mirror the platform's public models.
import { VerisError, VerisGatewayNotOfferedError, VerisGatewayUnreachableError, TwinExpiredError } from './errors'

export interface RouteEntry {
  /** A real vendor hostname the service answers for. */
  host: string
  /** Path prefixes narrowing the claim when several services share the host. */
  paths?: string[] | null
}

export interface ServiceInfo {
  name: string
  status: string
  /** What the code under test points at: gateway URL for http services, a DSN for e.g. postgres. */
  url: string
  /** Where /veris/* lives — always an http URL. */
  control_url: string
  env_hint?: string | null
  routes?: RouteEntry[] | null
}

export interface TwinSandbox {
  id: string
  environment_id: string
  status: 'provisioning' | 'ready' | 'failed' | 'degraded' | 'terminating' | string
  created_at?: string | null
  expires_at?: string | null
  services: ServiceInfo[]
  failure_reason?: string | null
  metadata?: Record<string, string>
}

/** Response of POST /v1/sandboxes/{sid}/egress-credential (gateway mode). */
export interface EgressCredential {
  /** SOCKS5 endpoint. What @veris-ai/e2b uses; Daytona cannot (it accepts only
   *  http/https outbound proxies). */
  socks_address: string
  /** HTTP CONNECT endpoint, host:port. Absent on a control plane that predates
   *  the CONNECT listener — which is a hard error here, since Daytona has no
   *  other way to reach the gateway. */
  connect_address?: string
  /** The CONNECT endpoint as a complete proxy URL, credentials included.
   *  Preferred over building one from connect_address: the gateway owns its own
   *  auth format, and guessing it is how you end up sending the wrong password. */
  http_proxy_url?: string
  username: string
  password: string
  ca_pem: string
  canary_host: string
  min_sdk?: string
  expires_at?: string
  /** Server-served CA trust env map; the SDK's vendored list is the fallback. */
  trust_env?: Record<string, string>
}

/** Mutable fields of a running twin. An OMITTED key is left alone; an explicit
 *  null is a value (client_base_url: null unregisters). */
export interface SandboxPatch {
  ttl_minutes?: number
  client_base_url?: string | null
}

export interface ControlPlaneOpts {
  apiKey: string
  apiBase: string
  /** Sent as X-Veris-SDK on every request, so the server can version-gate. */
  sdkVersion: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ControlPlane {
  readonly apiBase: string
  private readonly headers: Record<string, string>

  constructor(opts: ControlPlaneOpts) {
    this.apiBase = opts.apiBase.replace(/\/$/, '')
    this.headers = {
      'X-API-Key': opts.apiKey,
      'X-Veris-SDK': opts.sdkVersion,
      'Content-Type': 'application/json',
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response
    try {
      res = await fetch(`${this.apiBase}${path}`, {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (cause) {
      throw new VerisError(`Veris control plane unreachable (${method} ${path})`, { cause })
    }
    return res
  }

  private async json<T>(res: Response, context: string, phase?: import('./errors').VerisErrorPhase): Promise<T> {
    const text = await res.text()
    let parsed: unknown
    try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
    if (!res.ok) {
      throw new VerisError(`${context}: ${res.status}`, { phase, responseBody: parsed })
    }
    // A success with no body would surface downstream as an opaque
    // "cannot read properties of undefined" — turn it into a legible error here.
    if (parsed === undefined) {
      throw new VerisError(`${context}: empty response body`, { phase, responseBody: text })
    }
    return parsed as T
  }

  async createTwin(environmentId: string, opts: { ttlMinutes?: number; metadata?: Record<string, string> } = {}): Promise<TwinSandbox> {
    const res = await this.request('POST', `/v1/environments/${environmentId}/sandboxes`, {
      ttl_minutes: opts.ttlMinutes,
      metadata: opts.metadata,
    })
    // A 404 here is almost never a missing endpoint: environments are scoped to
    // one control plane, so the usual cause is an id from a DIFFERENT one --
    // a prod VERIS_ENVIRONMENT_ID against a dev VERIS_API_BASE, or the reverse.
    // The bare "404" sends people to check their key, which is fine, and their
    // network, which is fine, before they think to check the pairing.
    if (res.status === 404) {
      throw new VerisError(
        `environment '${environmentId}' does not exist on ${this.apiBase}. Environments belong ` +
        'to one control plane: check that VERIS_ENVIRONMENT_ID and VERIS_API_BASE name the same ' +
        'one (an id from the other environment gives exactly this 404).',
        { phase: 'twin-provision', responseBody: await res.text() })
    }
    return this.json<TwinSandbox>(res, `create sandbox in environment ${environmentId}`, 'twin-provision')
  }

  async getTwin(sandboxId: string): Promise<TwinSandbox | null> {
    const res = await this.request('GET', `/v1/sandboxes/${sandboxId}`)
    if (res.status === 404) return null
    return this.json<TwinSandbox>(res, `get sandbox ${sandboxId}`)
  }

  /** Poll until the twin reports ready. "failed" is terminal per the API docs. */
  async waitReady(sandboxId: string, timeoutMs: number): Promise<TwinSandbox> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const twin = await this.getTwin(sandboxId)
      if (!twin) throw new TwinExpiredError(`Veris sandbox ${sandboxId} disappeared while provisioning`, { verisSandboxId: sandboxId })
      if (twin.status === 'ready') return twin
      if (twin.status === 'failed') {
        throw new VerisError(
          `Veris sandbox ${sandboxId} failed to provision: ${twin.failure_reason ?? 'no failure_reason'}`,
          { phase: 'twin-provision', verisSandboxId: sandboxId })
      }
      if (Date.now() > deadline) {
        throw new VerisError(
          `Veris sandbox ${sandboxId} not ready after ${timeoutMs}ms (status: ${twin.status})`,
          { phase: 'twin-provision', verisSandboxId: sandboxId })
      }
      await sleep(1500)
    }
  }

  async services(sandboxId: string): Promise<ServiceInfo[]> {
    const res = await this.request('GET', `/v1/sandboxes/${sandboxId}/services`)
    if (res.status === 404) {
      throw new TwinExpiredError(`Veris sandbox ${sandboxId} not found — expired or deleted`, { verisSandboxId: sandboxId })
    }
    return this.json<ServiceInfo[]>(res, `services of sandbox ${sandboxId}`, 'receipt')
  }

  async deleteTwin(environmentId: string, sandboxId: string): Promise<boolean> {
    const res = await this.request('DELETE', `/v1/environments/${environmentId}/sandboxes/${sandboxId}`)
    if (res.status === 404) return false
    if (!res.ok) await this.json(res, `delete sandbox ${sandboxId}`)
    return true
  }

  /**
   * Mint (or re-mint) the gateway egress credential for a twin. Returns null
   * when the control plane does not offer gateway mode at all (404 — route
   * absent), so `mode: 'auto'` can fall back; throws VerisGatewayNotOfferedError
   * on an explicit version refusal (409 sdk_too_old).
   */
  async mintEgressCredential(environmentId: string, sandboxId: string): Promise<EgressCredential | null> {
    const res = await this.request('POST', `/v1/environments/${environmentId}/sandboxes/${sandboxId}/egress-credential`)
    if (res.status === 404) return null
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { min_sdk?: string }
      throw new VerisGatewayNotOfferedError(
        `this SDK version is below the control plane's minimum for gateway mode${body.min_sdk ? ` (min_sdk ${body.min_sdk})` : ''} — upgrade @veris-ai/daytona`,
        { phase: 'credential-mint', verisSandboxId: sandboxId, minSdk: body.min_sdk, responseBody: body })
    }
    return this.json<EgressCredential>(res, `mint egress credential for ${sandboxId}`, 'credential-mint')
  }

  /** PATCH the twin resource. Omitted fields are untouched by the server. */
  async updateSandbox(environmentId: string, sandboxId: string, patch: SandboxPatch): Promise<void> {
    const res = await this.request('PATCH', `/v1/environments/${environmentId}/sandboxes/${sandboxId}`, patch)
    if (res.status === 404) {
      throw new TwinExpiredError(`Veris sandbox ${sandboxId} not found`, { verisSandboxId: sandboxId })
    }
    if (!res.ok) await this.json(res, `update sandbox ${sandboxId}`)
  }

  /** Extend a twin's TTL so it stays in lockstep with an extended Daytona sandbox. */
  async extendTtl(environmentId: string, sandboxId: string, ttlMinutes: number): Promise<void> {
    const res = await this.request('PATCH', `/v1/environments/${environmentId}/sandboxes/${sandboxId}`, { ttl_minutes: ttlMinutes })
    if (res.status === 404) {
      throw new TwinExpiredError(`Veris sandbox ${sandboxId} not found — cannot extend TTL`, { verisSandboxId: sandboxId })
    }
    // 405 = a control plane that does not accept this field yet: tolerated, the
    // original TTL keeps its backstop role and kill() still cleans up.
    if (!res.ok && res.status !== 405) await this.json(res, `extend TTL of ${sandboxId}`)
  }

  /** Create-time preflight: is the gateway infrastructure up, per the control plane? */
  async gatewayHealth(): Promise<void> {
    const res = await this.request('GET', '/v1/gateway/health')
    if (res.status === 404) return // control plane predates gateway mode; the credential probe decides
    if (!res.ok) {
      throw new VerisGatewayUnreachableError(
        `Veris gateway reported unhealthy (${res.status})`, { phase: 'gateway-preflight' })
    }
  }
}
