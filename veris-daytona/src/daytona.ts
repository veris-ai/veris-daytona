// The Veris Daytona client: a drop-in subclass of @daytona/sdk's Daytona whose
// sandboxes come up with a Veris twin already answering their vendor calls.
//
// Everything the product needs happens inside create() — snapshot registration,
// twin provisioning, the network allowlist, the CA, starting the proxy and
// waiting for it to bind. That is deliberate: it keeps the OpenCode plugin's
// diff to a single changed import, and it means create() resolving is a promise
// that interception is live.
//
// Note we do NOT subclass Sandbox the way @veris-ai/e2b does. Daytona builds
// Sandbox internally from seven arguments, six of them private SDK types, so
// there is nothing to extend. We enrich the params, call super, and attach the
// Veris surface to the instance that comes back.
import { Daytona as BaseDaytona } from '@daytona/sdk'
import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  DaytonaConfig,
  Image,
  ListSandboxesQuery,
  Sandbox,
} from '@daytona/sdk'
import { ControlPlane } from './control-plane'
import type { TwinSandbox } from './control-plane'
import { VerisApiImpl } from './veris-api'
import type { VerisApi, VerisContext } from './veris-api'
import { buildNetwork, dataPlaneEnv, hostOf } from './network'
import type { EgressMode } from './network'
import { CA_CERT_PATH, sanitizeTrustEnv } from './trust'
import { ensureSnapshot } from './snapshot'
import { ensureProxy, probeTransparent, teardownProxy, PROXY_URL } from './proxy'
import type { ProxyTier } from './receipt'
import { MissingCredentialsError, VerisError } from './errors'
import { SDK_VERSION } from './version'

export interface VerisOpts {
  /** Veris API key. Falls back to process.env.VERIS_API_KEY. Required. */
  apiKey?: string
  /** Veris environment the twin is deployed from. Falls back to process.env.VERIS_ENVIRONMENT_ID. */
  environmentId?: string
  /** Control plane base. Falls back to process.env.VERIS_API_BASE, then 'https://svc.api.veris.ai'. */
  apiBase?: string
  /** Attach to an EXISTING twin instead of provisioning one (advanced). delete() will NOT remove it. */
  attachSandboxId?: string
  /** Twin TTL backstop, minutes. Default 60, kept in step with the sandbox's ttlMinutes. */
  ttlMinutes?: number
  /** 'strict' (default): the sandbox reaches only its twin, its data planes,
   *  the control plane and package registries. 'open': no allowlist at all —
   *  debugging only, because a bypassing client then reaches the real vendor. */
  egress?: EgressMode
  /** Extra hostnames to allow out. */
  allowOut?: string[]
  /** Allow package registries (npm, PyPI, apt, …). Default true: a coding
   *  sandbox that cannot install dependencies is not usable. */
  allowRegistries?: boolean
  /** Force a tier instead of probing. 'auto' (default) prefers transparent. */
  tier?: ProxyTier | 'auto'
  /** Snapshot name to ensure/use. Defaults to the pinned Veris snapshot. */
  snapshot?: string
  /** What the snapshot is registered from: a registry reference, or an `Image`
   *  Daytona builds server-side (`Image.fromDockerfile(...)` needs no registry). */
  snapshotImage?: string | Image
  /** Progress callback for the one-time snapshot registration. */
  onSnapshotLogs?: (chunk: string) => void
  /** Turn Veris off entirely for this create — a plain Daytona sandbox. */
  disabled?: boolean
}

export interface VerisDaytonaConfig extends DaytonaConfig {
  veris?: VerisOpts
}

type CreateParams = (CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams) & { veris?: VerisOpts }

/** Labels the class stamps so get() can rehydrate without re-asking. */
const LABEL = {
  twinId: 'veris_twin_id',
  envId: 'veris_env_id',
  apiBase: 'veris_api_base',
  mode: 'veris_mode',
  egress: 'veris_egress',
  ownsTwin: 'veris_owns_twin',
} as const

const VERIS_LABEL_KEYS: readonly string[] = Object.values(LABEL)

/** A Daytona sandbox with the Veris surface attached. */
export type VerisSandbox = Sandbox & {
  /** Receipts, services, assertions. Everything Veris adds. */
  veris: VerisApi
  /** The Veris twin's id. Not to be confused with `sandbox.id`, the Daytona one. */
  verisSandboxId: string
}

/** Is this sandbox one of ours? Narrows for callers who hold a bare Sandbox. */
export function isVerisSandbox(sbx: Sandbox): sbx is VerisSandbox {
  return typeof (sbx as VerisSandbox).verisSandboxId === 'string'
}

function warnCooperative(reason: string): void {
  process.emitWarning(
    `@veris-ai/daytona: the transparent tier is unavailable (${reason}), so this sandbox ` +
    `intercepts via HTTP_PROXY. Clients that honour it are intercepted; clients that do not ` +
    `are BLOCKED by the domain allowlist, never silently sent to the real vendor.`,
    { code: 'VERIS_PROXY_MODE' })
}

export class Daytona extends BaseDaytona {
  private readonly verisDefaults: VerisOpts

  constructor(config?: VerisDaytonaConfig) {
    super(config)
    this.verisDefaults = config?.veris ?? {}
  }

  // Both of the base class's overloads, redeclared so a caller passing either
  // params shape still type-checks against the subclass.
  override create(
    params?: CreateSandboxFromSnapshotParams & { veris?: VerisOpts },
    options?: { timeout?: number },
  ): Promise<Sandbox>
  override create(
    params?: CreateSandboxFromImageParams & { veris?: VerisOpts },
    options?: { onSnapshotCreateLogs?: (chunk: string) => void; timeout?: number },
  ): Promise<Sandbox>
  override async create(
    params?: CreateParams,
    options?: { onSnapshotCreateLogs?: (chunk: string) => void; timeout?: number },
  ): Promise<Sandbox> {
    const v: VerisOpts = { ...this.verisDefaults, ...(params?.veris ?? {}) }
    const rest = stripVeris(params)

    if (v.disabled) return this.baseCreate(rest, options)

    const coords = resolveCoordinates(v)
    const controlPlane = new ControlPlane({
      apiKey: coords.apiKey, apiBase: coords.apiBase, sdkVersion: SDK_VERSION,
    })
    const egress: EgressMode = v.egress ?? 'strict'
    const ttlMinutes = v.ttlMinutes ?? 60
    const ownsTwin = !v.attachSandboxId

    // 1. The snapshot must exist in THIS organization. First run in an org pays
    //    a one-time registration from the public image; later runs find it.
    //    Skipped when the caller brought their own image or snapshot.
    let snapshot: string | undefined
    const callerBroughtImage = 'image' in rest && rest.image !== undefined
    const callerSnapshot = (rest as CreateSandboxFromSnapshotParams).snapshot
    if (!callerBroughtImage) {
      snapshot = callerSnapshot ?? await ensureSnapshot(this, {
        name: v.snapshot, image: v.snapshotImage, onLogs: v.onSnapshotLogs,
      })
    }

    // 2. Provision the twin BEFORE the sandbox: the network allowlist needs its
    //    hostnames, and the sandbox env needs its id. An in-sandbox proxy that
    //    provisioned its own twin (serve --environment) would never tell us the
    //    id, leaving receipt() with nothing to read and teardown nothing to delete.
    const twin = await this.provisionTwin(controlPlane, v, coords, ttlMinutes)
    const cleanupTwin = async () => {
      if (ownsTwin) await controlPlane.deleteTwin(twin.environment_id, twin.id).catch(() => {})
    }

    let sandbox: Sandbox
    try {
      const services = twin.services?.length ? twin.services : await controlPlane.services(twin.id)
      const network = buildNetwork({
        services, mode: egress, apiBaseHost: hostOf(coords.apiBase),
        allowOut: v.allowOut, allowRegistries: v.allowRegistries,
      })

      // Veris-managed vars WIN over caller envs: a caller value for a
      // data-plane env_hint (e.g. DATABASE_URL) would silently point the code
      // under test at production.
      const verisManaged: Record<string, string> = {
        ...sanitizeTrustEnv(undefined),
        ...dataPlaneEnv(services),
        VERIS_SANDBOX_ID: twin.id,
        VERIS_API_KEY: coords.apiKey,
        VERIS_API_BASE: coords.apiBase,
        // NOTE no HTTP_PROXY here, deliberately.
        //
        // An earlier version set it unconditionally as "belt and braces". It is
        // the opposite: in the transparent tier the kernel redirect already has
        // the traffic, and an HTTP_PROXY on top makes curl issue an explicit
        // CONNECT to the forward listener, which answers 403 — a working
        // interception broken by a redundant variable. veris-proxy names this
        // case itself with `--env-trust-only`: "emit only the CA variables, for
        // a tier where the kernel already does the routing".
        //
        // The cooperative tier does need them, and only there are they written
        // — into /etc/profile.d, after the probe has told us which tier we got.
      }

      const createParams = {
        ...rest,
        ...(snapshot ? { snapshot } : {}),
        envVars: { ...(rest.envVars ?? {}), ...verisManaged },
        labels: {
          ...reserveLabels(rest.labels),
          [LABEL.twinId]: twin.id,
          [LABEL.envId]: twin.environment_id,
          [LABEL.apiBase]: coords.apiBase,
          [LABEL.egress]: egress,
          [LABEL.ownsTwin]: String(ownsTwin),
        },
        ...network,
        ttlMinutes: rest.ttlMinutes ?? ttlMinutes,
      }

      sandbox = await this.baseCreate(createParams as CreateParams, options)
    } catch (cause) {
      await cleanupTwin()
      if (cause instanceof VerisError) throw cause
      throw new VerisError('Daytona sandbox create failed', {
        phase: 'sandbox-create', verisSandboxId: twin.id, cause })
    }

    // 3. Bring the proxy up and do not return until it is serving. This is what
    //    makes the first tool call of a session safe.
    let mode: ProxyTier
    try {
      mode = await this.bringUpProxy(sandbox, twin.id, v)
    } catch (err) {
      await sandbox.delete().catch(() => {})
      await cleanupTwin()
      throw err
    }

    // Interception is carried by `sbx.veris.env()`, which callers pass to their
    // commands (and the OpenCode plugin passes automatically).
    //
    // Deliberately NOT by rewriting Daytona's own network enforcement. An
    // earlier version added an iptables rule diverting traffic bound for
    // Daytona's internal proxy to ours, plus a route_localnet flip. That routes
    // around their control plane from inside the sandbox: undocumented, fragile
    // against any Daytona change, and not a thing to ship to customers. It also
    // did not work. The supported fix is on Daytona's side — letting
    // outboundProxyUrl name an in-sandbox address, the way E2B's
    // network.egressProxy does — and until then, passing the env is honest and
    // fails closed.
    await writeProxyEnv(sandbox)

    // The mode label is only knowable now, after the probe.
    await sandbox.setLabels({ ...sandbox.labels, [LABEL.mode]: mode }).catch(() => {})

    return this.attach(sandbox, {
      controlPlane, environmentId: twin.environment_id, twinId: twin.id,
      mode, egress, ownsTwin,
    })
  }

  /**
   * Rehydrate the Veris surface on an existing sandbox.
   *
   * Not an optimisation — a necessity. The OpenCode plugin reconnects to a
   * sandbox with get() on every resumed session and deletes through get() too,
   * so a get() that returned a bare Sandbox would mean no receipts after any
   * restart and a leaked twin on every delete.
   */
  override async get(sandboxIdOrName: string): Promise<Sandbox> {
    const sandbox = await super.get(sandboxIdOrName)
    return this.rehydrate(sandbox)
  }

  /** Same rehydration for the sandboxes a list() streams. */
  override list(query?: ListSandboxesQuery): AsyncIterableIterator<Sandbox> {
    const inner = super.list(query)
    const rehydrate = (s: Sandbox) => this.rehydrate(s)
    return (async function* () {
      for await (const sandbox of inner) yield rehydrate(sandbox)
    })()
  }

  /**
   * Attach the Veris surface to a sandbox whose labels say it has a twin.
   * A sandbox without our labels is passed through untouched — callers can use
   * this client for ordinary Daytona work.
   */
  private rehydrate(sandbox: Sandbox): Sandbox {
    const labels = sandbox.labels ?? {}
    const twinId = labels[LABEL.twinId]
    if (!twinId) return sandbox

    const apiKey = this.verisDefaults.apiKey ?? process.env.VERIS_API_KEY
    if (!apiKey) return sandbox // no key: no Veris surface, but not an error

    // A trusted source decides where the API key is sent — NEVER the sandbox
    // labels, which a compromised sandbox could rewrite to exfiltrate the key.
    const trustedBase = this.verisDefaults.apiBase ?? process.env.VERIS_API_BASE
    const labelBase = labels[LABEL.apiBase]
    if (trustedBase && labelBase && labelBase !== trustedBase) {
      throw new VerisError(
        `sandbox ${sandbox.id} labels name a different Veris control plane (${labelBase}) than ` +
        `your configuration (${trustedBase}) — refusing to send the API key to an unverified host`,
        { phase: 'attach' })
    }
    const apiBase = trustedBase ?? labelBase ?? 'https://svc.api.veris.ai'

    return this.attach(sandbox, {
      controlPlane: new ControlPlane({ apiKey, apiBase, sdkVersion: SDK_VERSION }),
      environmentId: labels[LABEL.envId] ?? '',
      twinId,
      mode: (labels[LABEL.mode] as ProxyTier | undefined) ?? 'cooperative',
      egress: (labels[LABEL.egress] as EgressMode | undefined) ?? 'strict',
      ownsTwin: labels[LABEL.ownsTwin] !== 'false',
    })
  }

  private async provisionTwin(
    controlPlane: ControlPlane, v: VerisOpts, coords: ResolvedCoordinates, ttlMinutes: number,
  ): Promise<TwinSandbox> {
    if (v.attachSandboxId) {
      const existing = await controlPlane.getTwin(v.attachSandboxId)
      if (!existing) {
        throw new VerisError(`attach target ${v.attachSandboxId} not found`, {
          phase: 'twin-provision', verisSandboxId: v.attachSandboxId })
      }
      return existing.status === 'ready' ? existing : controlPlane.waitReady(v.attachSandboxId, 240_000)
    }
    if (!coords.environmentId) {
      throw new MissingCredentialsError(
        'no Veris environment: set VERIS_ENVIRONMENT_ID, or pass veris.environmentId',
        { phase: 'credentials' })
    }
    const created = await controlPlane.createTwin(coords.environmentId, { ttlMinutes })
    try {
      return await controlPlane.waitReady(created.id, 240_000)
    } catch (e) {
      await controlPlane.deleteTwin(coords.environmentId, created.id).catch(() => {})
      throw e
    }
  }

  /** Probe for the transparent tier, then start (or verify) the proxy. */
  private async bringUpProxy(sandbox: Sandbox, twinId: string, v: VerisOpts): Promise<ProxyTier> {
    let requested: ProxyTier
    if (v.tier === 'transparent' || v.tier === 'cooperative') {
      requested = v.tier
    } else {
      const probe = await probeTransparent(sandbox)
      requested = probe.ok ? 'transparent' : 'cooperative'
      if (!probe.ok) warnCooperative(probe.reason)
    }
    return ensureProxy(sandbox, { twinId, tier: requested })
  }

  /**
   * Hang the Veris surface off the instance, and wrap delete() so teardown is
   * automatic.
   *
   * Wrapping rather than asking callers to remember is the point: the OpenCode
   * plugin's existing `sandbox.delete()` then removes the twin too, with no
   * change to the plugin at all. A twin outlives its sandbox otherwise, until
   * its TTL reaps it — invisible until the bill arrives.
   */
  private attach(sandbox: Sandbox, ctx: Omit<VerisContext, 'sandbox'>): Sandbox {
    // Attaching twice would capture our own wrapper as `originalDelete` and
    // tear the twin down twice. Only the prototype's delete is ever wrapped.
    if (isVerisSandbox(sandbox)) return sandbox

    const veris = new VerisApiImpl({ ...ctx, sandbox })
    const originalDelete = sandbox.delete.bind(sandbox)

    Object.defineProperties(sandbox, {
      veris: { value: veris, enumerable: true, configurable: true },
      verisSandboxId: { value: ctx.twinId, enumerable: true, configurable: true },
      verisMode: { value: ctx.mode, enumerable: true, configurable: true },
      delete: {
        configurable: true,
        value: async (timeout?: number, wait?: boolean): Promise<void> => {
          // Stop the proxy and drop the twin before the container goes: a
          // SIGKILLed proxy runs no teardown of its own.
          await Promise.all([
            teardownProxy(sandbox).catch(() => {}),
            ctx.ownsTwin
              ? ctx.controlPlane.deleteTwin(ctx.environmentId, ctx.twinId).catch(() => {})
              : Promise.resolve(),
          ])
          return originalDelete(timeout, wait)
        },
      },
    })
    return sandbox
  }

  /** super.create through the overload the params actually match. */
  private baseCreate(
    params: CreateParams | undefined,
    options?: { onSnapshotCreateLogs?: (chunk: string) => void; timeout?: number },
  ): Promise<Sandbox> {
    type Create = (p?: CreateParams, o?: typeof options) => Promise<Sandbox>
    return (super.create as unknown as Create).call(this, params, options)
  }
}

export default Daytona

interface ResolvedCoordinates {
  apiKey: string
  environmentId?: string
  apiBase: string
}

function resolveCoordinates(v: VerisOpts): ResolvedCoordinates {
  const apiKey = v.apiKey ?? process.env.VERIS_API_KEY
  if (!apiKey) {
    throw new MissingCredentialsError(
      'no Veris API key: set VERIS_API_KEY in your environment, or pass veris.apiKey. ' +
      'Get one at https://app.veris.ai',
      { phase: 'credentials' })
  }
  return {
    apiKey,
    environmentId: v.environmentId ?? process.env.VERIS_ENVIRONMENT_ID,
    apiBase: (v.apiBase ?? process.env.VERIS_API_BASE ?? 'https://svc.api.veris.ai').replace(/\/$/, ''),
  }
}

/**
 * Cooperative tier only: make HTTP_PROXY visible to every later login shell.
 * Never in the transparent tier, where it breaks the interception it looks
 * like it would reinforce.
 */
async function writeProxyEnv(sandbox: Sandbox): Promise<void> {
  const script =
    `export HTTP_PROXY=${PROXY_URL} HTTPS_PROXY=${PROXY_URL} ` +
    `http_proxy=${PROXY_URL} https_proxy=${PROXY_URL} ` +
    `NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1`
  await sandbox.process
    .executeCommand(
      `sh -lc 'printf %s ${JSON.stringify(script)} > /etc/profile.d/veris-proxy.sh ` +
      `2>/dev/null || sudo -n sh -c "printf %s ${JSON.stringify(script)} > /etc/profile.d/veris-proxy.sh"'`,
      undefined, undefined, 30)
    .catch(() => { /* the allowlist is still the guarantee; this is routing only */ })
}

function stripVeris(params: CreateParams | undefined): Omit<CreateParams, 'veris'> {
  const { veris: _veris, ...rest } = params ?? {}
  return rest
}

/** Strip any Veris-reserved keys a caller tried to set in labels. */
function reserveLabels(labels: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(labels ?? {})) {
    if (!VERIS_LABEL_KEYS.includes(k)) out[k] = val
  }
  return out
}

export { CA_CERT_PATH }
