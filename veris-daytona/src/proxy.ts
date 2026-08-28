// Bringing veris-proxy up inside a Daytona sandbox, and proving it is up.
//
// The snapshot's entrypoint starts the proxy, but Daytona also runs its own
// daemon in the sandbox and we are not going to bet interception on
// undocumented PID-space behaviour. So: wait for the entrypoint's ready file,
// and if it never lands, start the proxy ourselves through a background
// session. Either way nothing returns until the listeners are bound.
import type { Sandbox } from '@daytona/sdk'
import { ProxyStartError, SnapshotUnsupportedError } from './errors'
import { CA_DIR, ENV_FILE, PROXY_UID, READY_FILE, VERIS_RUN_DIR, shellQuote } from './receipt'
import type { ProxyTier } from './receipt'

/**
 * The forward-proxy listener. This is what actually carries vendor traffic to
 * the twin: `sbx.veris.env()` points client stacks at it.
 *
 * Loopback-only. It briefly bound 0.0.0.0 to receive an iptables REDIRECT that
 * has since been deleted; nothing reaches it from off-host, so the narrower
 * bind is free.
 */
export const PROXY_LISTEN = '127.0.0.1:8080'
export const PROXY_URL = `http://${PROXY_LISTEN}`

const sh = (sandbox: Sandbox, cmd: string, timeoutSec = 60) =>
  sandbox.process.executeCommand(`sh -lc ${shellQuote(cmd)}`, undefined, undefined, timeoutSec)

/**
 * Can this sandbox host the transparent tier?
 *
 * `serve --transparent` installs an iptables REDIRECT, which needs NET_ADMIN
 * and root. Daytona applies its own rules to the sandbox container and does
 * not document whether we get the capability, so we ask rather than assume —
 * and the answer only picks a tier, it never blocks.
 */
export async function probeTransparent(sandbox: Sandbox): Promise<{ ok: boolean; reason: string }> {
  const probe = [
    'root=no; [ "$(id -u)" = 0 ] && root=yes || (sudo -n true 2>/dev/null && root=sudo)',
    'cap=no; (capsh --print 2>/dev/null | grep -qi net_admin) && cap=yes',
    'nft=no; (command -v nft >/dev/null 2>&1 || command -v iptables >/dev/null 2>&1) && nft=yes',
    'echo "root=$root cap=$cap nft=$nft"',
  ].join('; ')
  const r = await sh(sandbox, probe).catch(() => ({ exitCode: 1, result: '' }))
  const out = r.result ?? ''
  const rootOk = /root=(yes|sudo)/.test(out)
  const capOk = /cap=yes/.test(out)
  const toolOk = /nft=yes/.test(out)
  if (rootOk && capOk && toolOk) return { ok: true, reason: out.trim() }
  const missing = [
    rootOk ? null : 'no root',
    capOk ? null : 'no NET_ADMIN',
    toolOk ? null : 'no nft/iptables',
  ].filter(Boolean).join(', ')
  return { ok: false, reason: missing }
}

/** Is veris-proxy even present? A snapshot without it cannot intercept anything. */
export async function assertProxyPresent(sandbox: Sandbox): Promise<void> {
  const r = await sh(sandbox, 'command -v veris-proxy >/dev/null 2>&1 && veris-proxy version || echo __MISSING__')
    .catch(() => ({ exitCode: 1, result: '__MISSING__' }))
  if ((r.result ?? '').includes('__MISSING__')) {
    throw new SnapshotUnsupportedError(
      'this snapshot does not ship veris-proxy, so nothing would be intercepted — ' +
      'use the default Veris snapshot, or FROM ghcr.io/veris-ai/veris-sandbox in your own',
      { phase: 'proxy-start' })
  }
}

/**
 * The veris-proxy command line. Host-side rather than baked into the snapshot,
 * because a registered snapshot's entrypoint is immutable — see the note on
 * SNAPSHOT_ENTRYPOINT. Exported so the load-bearing flags can be pinned by test.
 */
export function proxyServeFlags(twinId: string, tier: ProxyTier): string {
  return [
    'serve',
    // The kernel redirect. Covers runtimes that ignore HTTP_PROXY entirely.
    tier === 'transparent' ? '--transparent' : '',
    // Deliberately NOT --strict.
    //
    // --strict makes veris-proxy refuse every UNMAPPED host. On a standalone
    // proxy that is the right default. Here it is redundant and harmful:
    // Daytona's domainAllowList already blocks unmapped hosts at the network
    // layer, unbypassably, so the only hosts that reach the proxy unmapped are
    // the ones we deliberately allowed — package registries. --strict refused
    // those with a 421, which broke `npm install` and `apt-get` for every
    // command carrying veris.env(). Mapped vendor hosts go to the twin either
    // way; --strict never affected them.
    // Attach to the twin the HOST provisioned. Never --environment, which would
    // make the in-sandbox proxy the twin's owner and leave the host unable to
    // read a receipt or delete it.
    `--sandbox ${shellQuote(twinId)}`,
    `--listen ${PROXY_LISTEN}`,
    // Must be writable by the uid the proxy drops to; $HOME/.veris is not.
    `--ca-dir ${CA_DIR}`,
    // The readiness signal create() blocks on.
    `--ready-file ${READY_FILE}`,
    `--write-env ${ENV_FILE}`,
    '--log-format json',
  ].filter(Boolean).join(' ')
}

export interface StartProxyOpts {
  twinId: string
  tier: ProxyTier
  /** Seconds to wait for the listeners to bind. */
  timeoutSec?: number
}

/**
 * Ensure the proxy is serving. Idempotent: if the entrypoint already brought it
 * up (ready file present) this only verifies, so a resumed sandbox costs one
 * `test -f`.
 */
export async function ensureProxy(sandbox: Sandbox, opts: StartProxyOpts): Promise<ProxyTier> {
  const { twinId, tier, timeoutSec = 180 } = opts

  if (await isReady(sandbox)) return await readTier(sandbox, tier)

  await assertProxyPresent(sandbox)

  // The entrypoint did not (or could not) run. Start it ourselves in a
  // background session so it outlives this exec — a plain executeCommand would
  // be reaped the moment the call returns.
  const flags = proxyServeFlags(twinId, tier)
  // Root when we can get it: the transparent tier needs it to install the
  // redirect and to write the CA into the system store.
  const runner = tier === 'transparent' ? 'sudo -n -E ' : ''
  const cmd =
    `(mkdir -p ${CA_DIR} 2>/dev/null || sudo -n mkdir -p ${CA_DIR}); ` +
    `(chown -R ${PROXY_UID}:${PROXY_UID} ${VERIS_RUN_DIR} 2>/dev/null || ` +
    `sudo -n chown -R ${PROXY_UID}:${PROXY_UID} ${VERIS_RUN_DIR} 2>/dev/null || true); ` +
    `(chmod 755 ${VERIS_RUN_DIR} ${CA_DIR} 2>/dev/null || sudo -n chmod 755 ${VERIS_RUN_DIR} ${CA_DIR} || true); ` +
    `${runner}veris-proxy ${flags} >>${VERIS_RUN_DIR}/serve.log 2>&1`

  const sessionId = `veris-proxy-${twinId}`
  await sandbox.process.createSession(sessionId).catch(() => { /* already exists */ })
  await sandbox.process.executeSessionCommand(sessionId, {
    command: `sh -lc ${shellQuote(cmd)}`,
    runAsync: true,
  })

  await waitReady(sandbox, timeoutSec, twinId)
  return await readTier(sandbox, tier)
}

async function isReady(sandbox: Sandbox): Promise<boolean> {
  const r = await sh(sandbox, `[ -f ${READY_FILE} ] && echo yes || echo no`, 20)
    .catch(() => ({ exitCode: 1, result: 'no' }))
  return (r.result ?? '').includes('yes')
}

/**
 * Block until the listeners are bound. This is the step that makes the product
 * safe: the plugin's first tool call cannot run before interception is live,
 * so a session can never leak its opening vendor requests.
 */
export async function waitReady(sandbox: Sandbox, timeoutSec: number, twinId: string): Promise<void> {
  const cmd =
    `for i in $(seq 1 ${timeoutSec}); do [ -f ${READY_FILE} ] && exit 0; sleep 1; done; ` +
    `echo "__VERIS_NOT_READY__"; tail -40 ${VERIS_RUN_DIR}/serve.log 2>/dev/null`
  const r = await sh(sandbox, cmd, timeoutSec + 30).catch((e: unknown) => ({
    exitCode: 1, result: String(e),
  }))
  if (r.exitCode !== 0 || (r.result ?? '').includes('__VERIS_NOT_READY__')) {
    throw new ProxyStartError(
      `veris-proxy never became ready in the Daytona sandbox after ${timeoutSec}s — ` +
      `nothing is intercepted, so the sandbox was not started. Log tail:\n${(r.result ?? '').slice(0, 2000)}`,
      { phase: 'proxy-start', verisSandboxId: twinId })
  }
}

/** What the proxy reports it actually did, which can differ from what we asked
 *  for (an entrypoint-started proxy may have had capabilities we did not). */
async function readTier(sandbox: Sandbox, requested: ProxyTier): Promise<ProxyTier> {
  const r = await sh(sandbox, `grep -c transparent ${VERIS_RUN_DIR}/serve.log 2>/dev/null || echo 0`, 20)
    .catch(() => ({ exitCode: 1, result: '0' }))
  const sawTransparent = parseInt((r.result ?? '0').trim(), 10) > 0
  return sawTransparent ? 'transparent' : requested === 'transparent' ? 'transparent' : 'cooperative'
}

/**
 * The trust material the code under test needs (CA paths, JAVA_TOOL_OPTIONS…),
 * read back from the env file `serve --write-env` produced. Posix format is
 * `export NAME='value'`.
 */
export async function readProxyEnv(sandbox: Sandbox): Promise<Record<string, string>> {
  const r = await sh(sandbox, `cat ${ENV_FILE} 2>/dev/null || true`, 30)
    .catch(() => ({ exitCode: 1, result: '' }))
  const envs: Record<string, string> = {}
  for (const line of (r.result ?? '').split('\n')) {
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'(.*)'|"(.*)"|(.*))$/)
    if (m?.[1]) envs[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return envs
}

/**
 * Stop the proxy. The twin is deleted by the host (we provisioned it), so this
 * only releases the in-sandbox process — best-effort, since `sandbox.delete()`
 * is about to take the whole container anyway.
 */
export async function teardownProxy(sandbox: Sandbox): Promise<void> {
  await sh(sandbox,
    'pkill -TERM -x veris-proxy 2>/dev/null || sudo -n pkill -TERM -x veris-proxy 2>/dev/null; ' +
    'for i in $(seq 1 10); do pgrep -x veris-proxy >/dev/null || exit 0; sleep 1; done', 30,
  ).catch(() => { /* teardown is advisory */ })
}
