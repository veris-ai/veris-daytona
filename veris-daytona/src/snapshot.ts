// Getting the Veris snapshot into the caller's Daytona organization.
//
// Daytona snapshots carry an organizationId, so one we publish cannot be
// referenced by someone else's account — there is no "public snapshot" to point
// at. What IS shareable is a public registry image. So the first create in an
// org registers a snapshot from that image, and every later create finds it.
// This is what makes the product a one-line install rather than a setup guide.
import type { Daytona as BaseDaytona, Image } from '@daytona/sdk'
import { DaytonaConflictError, DaytonaNotFoundError, SnapshotState } from '@daytona/sdk'
import { VerisError } from './errors'
import { CA_DIR, ENV_FILE, PROXY_UID, READY_FILE, VERIS_RUN_DIR } from './receipt'
import { PROXY_LISTEN } from './proxy'

/**
 * The default image the snapshot is registered from: the generic Veris sandbox
 * — veris-proxy and a CA, no language toolchain, no agent. This package is the
 * Veris integration for Daytona, the same way @veris-ai/e2b is for E2B, so its
 * default must not presume what you are going to run.
 *
 * Consumers that need a toolchain build on it and point us at theirs, via
 * `veris.snapshotImage` / `veris.snapshot` or the env vars below.
 * @veris-ai/daytona-opencode does exactly that with veris-opencode.
 *
 * Pinned: the snapshot name carries this version, so bumping it re-registers
 * rather than mutating a snapshot in place.
 */
export const SNAPSHOT_IMAGE = 'ghcr.io/veris-ai/veris-sandbox'
export const SNAPSHOT_IMAGE_VERSION = '0.1.0'
export const SNAPSHOT_NAME = `veris-sandbox-${SNAPSHOT_IMAGE_VERSION}`

/** Env overrides, so a consumer can choose the image without threading options
 *  through every `new Daytona()` call site. */
export const SNAPSHOT_IMAGE_ENV = 'VERIS_SNAPSHOT_IMAGE'
export const SNAPSHOT_NAME_ENV = 'VERIS_SNAPSHOT'

/**
 * The snapshot's entrypoint: prepare the run directory, then idle.
 *
 * Deliberately free of proxy flags. A registered snapshot's entrypoint is
 * IMMUTABLE, so every change to the veris-proxy command line would mean
 * deleting the snapshot and paying a full image rebuild — and worse, a stale
 * snapshot silently runs the old command line while the code believes it
 * changed. (That cost a debugging cycle: the code said --listen 0.0.0.0 while
 * the live sandbox was still bound to 127.0.0.1 from an earlier registration.)
 *
 * So the flags live in ensureProxy(), host-side, where they can change without
 * touching the image. create() does not resolve until the proxy is bound, so
 * starting it a moment later costs nothing: no caller has the sandbox yet.
 */
export const SNAPSHOT_ENTRYPOINT: readonly string[] = [
  'sh', '-lc',
  `mkdir -p ${CA_DIR}; chown -R ${PROXY_UID}:${PROXY_UID} ${VERIS_RUN_DIR} 2>/dev/null || true; ` +
  `chmod 755 ${VERIS_RUN_DIR} ${CA_DIR} 2>/dev/null || true; exec sleep infinity`,
]

export interface EnsureSnapshotOpts {
  /** Snapshot name to ensure. Defaults to SNAPSHOT_NAME. */
  name?: string
  /**
   * What to register from. A string is a registry reference. An `Image` is a
   * declarative build Daytona performs server-side — including
   * `Image.fromDockerfile('snapshot/base/Dockerfile')`, which is how you run
   * against an image that has not been published to a registry yet.
   */
  image?: string | Image
  /** Called with build logs the first time a snapshot is registered, so the
   *  plugin can toast progress instead of appearing to hang. */
  onLogs?: (chunk: string) => void
  /** Seconds to allow for the one-time registration. */
  timeoutSec?: number
}

/**
 * Idempotent. Returns the snapshot name to pass as `snapshot` on create.
 *
 * Concurrency matters here: OpenCode opens several sessions at once, so two
 * creates can race on the first run in an org. A conflict means the other one
 * won — re-get rather than fail.
 */
export async function ensureSnapshot(
  daytona: BaseDaytona,
  opts: EnsureSnapshotOpts = {},
): Promise<string> {
  const name = opts.name ?? process.env[SNAPSHOT_NAME_ENV] ?? SNAPSHOT_NAME
  const image: string | Image = opts.image
    ?? process.env[SNAPSHOT_IMAGE_ENV]
    ?? `${SNAPSHOT_IMAGE}:${SNAPSHOT_IMAGE_VERSION}`

  const existing = await getSnapshot(daytona, name)
  if (existing === 'ready') return name
  if (existing === 'building') {
    await waitSnapshotReady(daytona, name, opts.timeoutSec ?? 900)
    return name
  }

  try {
    await daytona.snapshot.create(
      { name, image, entrypoint: [...SNAPSHOT_ENTRYPOINT] },
      { onLogs: opts.onLogs, timeout: opts.timeoutSec ?? 900 },
    )
  } catch (err) {
    // Another session registered it between our get and our create.
    if (err instanceof DaytonaConflictError) {
      await waitSnapshotReady(daytona, name, opts.timeoutSec ?? 900)
      return name
    }
    throw new VerisError(
      `could not register the Veris snapshot '${name}' from ` +
      `${typeof image === 'string' ? image : 'the supplied Image build'} ` +
      `in your Daytona organization`,
      { phase: 'snapshot-ensure', cause: err })
  }
  return name
}

type SnapshotStatus = 'ready' | 'building' | 'absent'

async function getSnapshot(daytona: BaseDaytona, name: string): Promise<SnapshotStatus> {
  try {
    const snap = await daytona.snapshot.get(name)
    if (snap.state === SnapshotState.ACTIVE) return 'ready'
    // A deactivated snapshot never progresses on its own — waiting on it would
    // hang until the timeout. Reactivate and let the poll pick it up.
    if (snap.state === SnapshotState.INACTIVE) {
      await daytona.snapshot.activate(snap)
      return 'building'
    }
    if (snap.state === SnapshotState.ERROR || snap.state === SnapshotState.BUILD_FAILED) {
      throw new VerisError(
        `the Veris snapshot '${name}' is in state ${snap.state}${snap.errorReason ? `: ${snap.errorReason}` : ''} — ` +
        `delete it (daytona.snapshot.delete('${name}')) and retry to re-register it`,
        { phase: 'snapshot-ensure' })
    }
    return 'building'
  } catch (err) {
    if (err instanceof DaytonaNotFoundError) return 'absent'
    throw err
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitSnapshotReady(daytona: BaseDaytona, name: string, timeoutSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000
  for (;;) {
    // An image build runs for minutes, so a transient API error mid-poll is
    // expected rather than exceptional — retry until the deadline instead of
    // throwing away a build that is still running. A VerisError is ours (the
    // snapshot genuinely failed) and stays fatal.
    let status: SnapshotStatus
    try {
      status = await getSnapshot(daytona, name)
    } catch (err) {
      if (err instanceof VerisError) throw err
      if (Date.now() > deadline) throw err
      await sleep(5000)
      continue
    }
    if (status === 'ready') return
    if (Date.now() > deadline) {
      throw new VerisError(
        `the Veris snapshot '${name}' was still building after ${timeoutSec}s`,
        { phase: 'snapshot-ensure' })
    }
    await sleep(3000)
  }
}
