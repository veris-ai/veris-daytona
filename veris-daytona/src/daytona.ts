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
import type { ServiceInfo, TwinSandbox } from './control-plane'
import { VerisApiImpl } from './veris-api'
import type { VerisApi, VerisContext } from './veris-api'
import { DAYTONA_DOMAIN_LIMIT, buildNetwork, dataPlaneEnv, isHttpUrl } from './network'
import type { EgressMode } from './network'
import { fetchWatermark } from './receipt'
import { CA_CERT_PATH, nodeOptionsWithTrust, sanitizeTrustEnv } from './trust'
import { gatewayProxyUrl, installCa, probeCanary } from './gateway'
import { MissingCredentialsError, VerisError, VerisGatewayNotOfferedError } from './errors'
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
  /** Install the gateway CA into the sandbox trust store. Default true; without
   *  it every HTTPS call to a vendor host fails certificate validation. */
  installCa?: boolean
  /** Inject { [env_hint]: dsn } for non-HTTP twin services. Default true. */
  dataPlaneEnv?: boolean
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
  canaryHost: 'veris_canary_host',
  /** Unique to ONE create() call, and the only way back to a sandbox whose
   *  create threw before it could hand the object over — see reapFailedCreate.
   *  The twin id will not do: an attached twin is shared by every sandbox on
   *  it, and deleting the wrong one of those would be worse than the leak. */
  createId: 'veris_create_id',
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

/**
 * The twin id stamped on this sandbox at create, if it has one.
 *
 * Read from the labels rather than from `sandbox.verisSandboxId`, so it answers
 * for a sandbox whose Veris surface could NOT be rehydrated — no VERIS_API_KEY
 * in the environment, say. That is exactly the case where a caller about to
 * delete the sandbox needs telling that a twin exists and is out of reach.
 */
export function verisTwinId(sandbox: Sandbox): string | undefined {
  return sandbox.labels?.[LABEL.twinId]
}

/**
 * Does deleting this sandbox delete its twin too?
 *
 * True only for a twin this package created. A twin attached to with
 * `veris.attachSandboxId` belongs to whoever made it and outlives the sandbox,
 * and a sandbox with no twin at all has nothing to delete. This is the same
 * label the wrapped `delete()` reads, so the two can never disagree.
 */
export function verisOwnsTwin(sandbox: Sandbox): boolean {
  const labels = sandbox.labels ?? {}
  return labels[LABEL.twinId] !== undefined && labels[LABEL.ownsTwin] !== 'false'
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
    // Stamped on the sandbox in the same request that asks for it, so this
    // call can find what it made even when nothing was handed back.
    const createId = crypto.randomUUID()

    // 1. Provision the twin first: the allowlist needs the vendor hostnames it
    //    answers for, and the egress credential is minted against it.
    const twin = await this.provisionTwin(controlPlane, v, coords, ttlMinutes)
    const cleanupTwin = async () => {
      if (ownsTwin) await controlPlane.deleteTwin(twin.environment_id, twin.id).catch(() => {})
    }

    let sandbox: Sandbox
    let credential
    let watermarks: Record<string, number> = {}
    // Everything before this line fails without Daytona having heard of us, so
    // there is nothing out there to reap and no call worth spending on looking.
    let daytonaAsked = false
    try {
      // 2. Mint the egress credential. Daytona accepts only http/https outbound
      //    proxies, so a control plane that offers SOCKS alone cannot be used
      //    here at all — say so plainly rather than failing later in TLS.
      credential = await controlPlane.mintEgressCredential(twin.environment_id, twin.id)
      if (!credential) {
        throw new VerisGatewayNotOfferedError(
          'this Veris control plane does not offer egress credentials, so there is no gateway ' +
          'for the sandbox to route through',
          { phase: 'credential-mint', verisSandboxId: twin.id })
      }
      if (!credential.connect_address && !credential.http_proxy_url) {
        throw new VerisGatewayNotOfferedError(
          'the Veris gateway offers SOCKS5 but no HTTP CONNECT endpoint, and Daytona accepts ' +
          'only http/https outbound proxies ("Unsupported outbound proxy scheme"). Upgrade the ' +
          'control plane to one that returns connect_address.',
          { phase: 'credential-mint', verisSandboxId: twin.id })
      }

      const services = twin.services?.length ? twin.services : await controlPlane.services(twin.id)
      // Validated here, before it reaches either the allowlist or Daytona.
      const proxyUrl = gatewayProxyUrl(credential)
      const network = buildNetwork({
        services, mode: egress,
        // The gateway has to be reachable or nothing is: taken from the URL we
        // are actually going to use, so the two can never disagree.
        gatewayHosts: [new URL(proxyUrl).hostname, credential.canary_host].filter(Boolean),
        allowOut: v.allowOut, allowRegistries: v.allowRegistries,
      })
      if (network.droppedRegistries.length) {
        // Said out loud, because the failure it causes lands much later and
        // blames the wrong thing: a `cargo build` that cannot reach crates.io
        // reads as a broken sandbox rather than as an allowlist that was full.
        process.stderr.write(
          `veris: Daytona allows ${DAYTONA_DOMAIN_LIMIT} domains and this twin's own hosts take ` +
          `most of them, so these registries were left off: ` +
          `${network.droppedRegistries.join(', ')}. Name the ones you need in veris.allowOut, ` +
          `or set veris.allowRegistries: false to spend every remaining slot yourself.\n`)
      }

      // Where each service's log stands BEFORE anything can have run in the
      // sandbox: the receipt counts from here, so an attached twin's earlier
      // traffic is not credited to this run.
      watermarks = await readWatermarks(services)

      // Veris-managed vars WIN over caller envs: a caller value for a
      // data-plane env_hint (e.g. DATABASE_URL) would silently point the code
      // under test at production.
      const verisManaged: Record<string, string> = {
        ...(v.installCa !== false ? sanitizeTrustEnv(undefined) : {}),
        // Node reads none of the variables above once Daytona has overwritten
        // them; the flag makes it read OpenSSL's store, which the CA install
        // fills. Appended, not replaced: a caller's own NODE_OPTIONS keep working.
        ...(v.installCa !== false ? { NODE_OPTIONS: nodeOptionsWithTrust(rest.envVars?.NODE_OPTIONS) } : {}),
        ...(v.dataPlaneEnv !== false ? dataPlaneEnv(services) : {}),
        VERIS_SANDBOX_ID: twin.id,
      }

      const createParams = {
        ...rest,
        envVars: { ...(rest.envVars ?? {}), ...verisManaged },
        labels: {
          ...reserveLabels(rest.labels),
          [LABEL.twinId]: twin.id,
          [LABEL.envId]: twin.environment_id,
          [LABEL.apiBase]: coords.apiBase,
          [LABEL.egress]: egress,
          [LABEL.ownsTwin]: String(ownsTwin),
          [LABEL.mode]: 'gateway',
          [LABEL.canaryHost]: credential.canary_host,
          [LABEL.createId]: createId,
        },
        ...network.params,
        // 3. Where Daytona forwards everything the allowlist permits. Chained,
        //    not advisory: an unreachable gateway makes allowed traffic 502
        //    rather than quietly going direct.
        outboundProxyUrl: proxyUrl,
        ttlMinutes: rest.ttlMinutes ?? ttlMinutes,
      }

      daytonaAsked = true
      sandbox = await this.baseCreate(createParams as CreateParams, options)
    } catch (cause) {
      // Daytona has a sandbox from the moment it accepts the request, but the
      // SDK only hands one back once it has STARTED — so an image that fails
      // to build leaves a box behind in `build_failed` that nothing here ever
      // held a reference to. Reap it first: it also carries the only account
      // of what went wrong.
      const failed = daytonaAsked
        ? await reapFailedCreate((labels) => super.list({ labels }), createId)
        : undefined
      await cleanupTwin()
      if (cause instanceof VerisError) throw cause
      throw new VerisError(sandboxCreateMessage(cause, failed, rest as { image?: unknown }), {
        phase: 'sandbox-create', verisSandboxId: twin.id, cause })
    }

    // 4. Trust the gateway's CA, then prove the tunnel is live. Until the canary
    //    answers, nothing about this sandbox is worth believing.
    try {
      await installCa(sandbox, credential.ca_pem)
      await probeCanary(sandbox, credential.canary_host, twin.id)
    } catch (err) {
      await sandbox.delete().catch(() => {})
      await cleanupTwin()
      throw err
    }

    return this.attach(sandbox, {
      controlPlane, environmentId: twin.environment_id, twinId: twin.id,
      egress, ownsTwin, canaryHost: credential.canary_host, watermarks,
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
      // Re-minted below when a receipt is actually asked for; the label only
      // has to survive the reconnect.
      canaryHost: labels[LABEL.canaryHost] ?? '',
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
      delete: {
        configurable: true,
        value: async (timeout?: number, wait?: boolean): Promise<void> => {
          // Drop the twin before the container goes. Nothing to stop inside
          // the sandbox — the gateway is ours and host-side.
          if (ctx.ownsTwin) {
            await ctx.controlPlane.deleteTwin(ctx.environmentId, ctx.twinId).catch(() => {})
          }
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
      'Get one at https://studio.veris.ai',
      { phase: 'credentials' })
  }
  return {
    apiKey,
    environmentId: v.environmentId ?? process.env.VERIS_ENVIRONMENT_ID,
    apiBase: (v.apiBase ?? process.env.VERIS_API_BASE ?? 'https://svc.api.veris.ai').replace(/\/$/, ''),
  }
}

/** What a create that threw left behind in Daytona, once it has been read back. */
export interface FailedSandbox {
  /** The DAYTONA sandbox id. Not the twin's. */
  id: string
  /** Daytona's own state for it — `build_failed` for an image that never built. */
  state?: string
  /** Daytona's account of what went wrong, when it kept one. */
  errorReason?: string
  /** Whether the delete actually went through. The message says either way,
   *  because "was deleted" has to be true or it is worse than saying nothing. */
  deleted: boolean
}

/** The parts of a Daytona Sandbox the reaper touches. */
interface ReapableSandbox {
  id: string
  state?: string
  errorReason?: string
  labels?: Record<string, string>
  refreshData(): Promise<void>
  delete(): Promise<void>
}

/**
 * Delete the half-built sandbox a failed create() left in Daytona, and bring
 * back the reason Daytona recorded for it.
 *
 * The leak this exists for: `create({ image: 'only-on-my-laptop' })` builds
 * server-side and fails at build time, so the SDK throws instead of returning
 * a Sandbox — and a box sits in `build_failed` that nothing here can delete,
 * until an autoDeleteInterval eventually reaps it. Found by the create id
 * stamped in its labels, which is the one thing about it we know for certain.
 *
 * Best effort throughout: the create is already failing, and a reaper that
 * threw would replace the real reason with its own.
 */
export async function reapFailedCreate(
  list: (labels: Record<string, string>) => AsyncIterable<ReapableSandbox>,
  createId: string,
): Promise<FailedSandbox | undefined> {
  try {
    for await (const sandbox of list({ [LABEL.createId]: createId })) {
      // Checked again on our side. A server-side filter that came back wider
      // than it was asked for must not turn into a delete of someone else's
      // sandbox — the one failure mode worse than the leak.
      if (sandbox.labels?.[LABEL.createId] !== createId) continue
      // The list row carries errorReason, but a row read the instant a build
      // failed can still be without one; one more fetch settles it. A failed
      // create is not a hot path.
      if (!sandbox.errorReason) await sandbox.refreshData().catch(() => {})
      const found = { id: sandbox.id, state: sandbox.state, errorReason: sandbox.errorReason }
      return { ...found, deleted: await sandbox.delete().then(() => true, () => false) }
    }
  } catch {
    // A list that cannot be read tells us nothing; the create's own error stands.
  }
  return undefined
}

/**
 * What a failed create says.
 *
 * Two things were missing from "Daytona sandbox create failed: Sandbox 7ba4…
 * failed to start with status: build_failed, error reason: null".
 *
 * The reason, first. Daytona's SDK renders `error reason: ${this.errorReason}`
 * off the Sandbox object it was polling, and the state change that ends the
 * wait arrives over the event stream, which carries the new state and not the
 * reason — so the field is still the null it started as, while Daytona's own
 * record for that sandbox says "pull access denied, repository does not
 * exist". Reading the record back is the whole fix.
 *
 * And, for the failure a first-timer actually hits, whose image it is. Daytona
 * resolves and builds it on its own machines, from a registry; the tag sitting
 * in the laptop's Docker daemon is not something it can see.
 *
 * The cause's own text is folded in HERE rather than left to VerisError, whose
 * fold would otherwise append it after the sentences that explain it.
 */
export function sandboxCreateMessage(
  cause: unknown,
  failed: FailedSandbox | undefined,
  params: { image?: unknown } = {},
): string {
  const base = 'Daytona sandbox create failed'
  // Nothing was made, so there is nothing to add: the cause is the story, and
  // VerisError folds it in.
  if (!failed) return base

  const reason = failed.errorReason?.trim().replace(/[.\s]+$/, '')
  const parts = [reason ? `${base}: ${reason}.` : `${base}.`]

  const image = typeof params.image === 'string' ? params.image : undefined
  if (image && failed.state === 'build_failed') {
    parts.push(
      `Daytona builds "${image}" on its own servers and pulls it from a registry, so an image ` +
      'that exists only in your local Docker daemon is not one it can see.')
  }
  parts.push(failed.deleted
    ? `The half-built sandbox ${failed.id} was deleted.`
    : `The half-built sandbox ${failed.id} could not be deleted — remove it with ` +
      `\`veris-daytona teardown ${failed.id}\`.`)

  const raw = cause instanceof Error ? cause.message : ''
  if (raw) parts.push(`(Daytona SDK: ${raw})`)
  return parts.join(' ')
}

/**
 * Each service's newest request id right now, keyed by service name.
 *
 * Best-effort per service, on purpose: a mark that cannot be read falls back
 * to 0, which reads the whole log — the behaviour the receipt had before
 * watermarks existed. A twin whose log is briefly unreadable must not be a
 * failed create().
 */
async function readWatermarks(services: ServiceInfo[]): Promise<Record<string, number>> {
  const marks = await Promise.all(
    services.filter((s) => isHttpUrl(s.control_url)).map(async (svc) =>
      [svc.name, await fetchWatermark(svc).catch(() => 0)] as const))
  return Object.fromEntries(marks)
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
