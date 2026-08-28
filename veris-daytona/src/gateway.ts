// Gateway mode: the sandbox's egress is routed through the Veris gateway, which
// answers vendor hostnames from the twin. Nothing Veris runs inside the sandbox
// but one CA file.
//
// This is the same tier @veris-ai/e2b uses (there via network.egressProxy), and
// the reason Daytona can host it is that outboundProxyUrl is genuinely chained:
// Daytona's proxy forwards allowed traffic to it and returns 502 when it cannot.
//
// Two things still have to happen inside the sandbox, and both are here:
// install the gateway's CA so the forged vendor leaves validate, and prove the
// tunnel is actually live before anyone trusts a receipt.
import type { Sandbox } from '@daytona/sdk'
import { ReceiptIntegrityError, SnapshotUnsupportedError, VerisError } from './errors'
import { CA_CERT_PATH, CA_INSTALL_CMD, CA_TOOLING_PROBE } from './trust'

/** A canary hostname must look like a hostname before it goes in a shell command. */
const HOSTNAME_RE = /^[A-Za-z0-9.-]+$/
/** host:port, the only shape an outbound proxy address may take. */
const HOSTPORT_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/

/** Single-quote a string for POSIX sh. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const sh = (sandbox: Sandbox, cmd: string, timeoutSec = 60) =>
  sandbox.process.executeCommand(`sh -lc ${shellQuote(cmd)}`, undefined, undefined, timeoutSec)

/**
 * Build the proxy URL Daytona is handed.
 *
 * The username is the tenant demux key — the gateway reads the sandbox id out
 * of it. There is no separate secret: the id IS the capability, exactly as the
 * SOCKS path treats it, so the password is a placeholder the gateway ignores.
 *
 * RFC 3986 §3.2.1 notes that `user:password` in userinfo is deprecated. It is
 * also the only form HTTP proxy clients accept for RFC 7617 Basic credentials,
 * and it is what Daytona forwards, so it is what we emit.
 *
 * `encodeURIComponent` is exactly right for userinfo: everything it leaves raw
 * is unreserved or a sub-delim, and it escapes both separators — `:` to %3A and
 * `@` to %40 — so a username can never break out into the authority.
 *
 * The address is validated rather than interpolated: it arrives from the
 * control plane, and an unchecked value here would land in a URL and then in
 * every client's proxy configuration.
 */
export function gatewayProxyUrl(connectAddress: string, username: string): string {
  if (!HOSTPORT_RE.test(connectAddress)) {
    throw new VerisError(
      `the control plane returned a malformed gateway address: ${JSON.stringify(connectAddress)} ` +
      `(expected host:port)`,
      { phase: 'credential-mint' })
  }
  return `http://${encodeURIComponent(username)}:x@${connectAddress}`
}

/** Drop the CA on disk so a client can --cacert it even if the system install is declined. */
export async function writeCa(sandbox: Sandbox, caPem: string): Promise<void> {
  await sandbox.fs.uploadFile(Buffer.from(caPem, 'utf8'), CA_CERT_PATH)
}

/**
 * Trust the gateway CA system-wide: probe the tooling, then one root command.
 *
 * Without this every HTTPS call to a vendor host fails certificate validation,
 * because the gateway presents a leaf it forged for that hostname.
 */
export async function installCa(sandbox: Sandbox): Promise<void> {
  const probe = await sh(sandbox, CA_TOOLING_PROBE, 60).catch(() => ({ exitCode: 1, result: '' }))
  if (!(probe.result ?? '').includes('ok')) {
    throw new SnapshotUnsupportedError(
      'this sandbox image lacks ca-certificates / update-ca-certificates, so the Veris CA ' +
      'cannot be trusted and every vendor call would fail TLS — use an image that ships them',
      { phase: 'ca-install' })
  }
  await sh(sandbox, CA_INSTALL_CMD, 120)
}

/**
 * The canary probe: one HTTPS request from inside the sandbox to a reserved
 * hostname only the gateway answers, with the twin id in the body.
 *
 * Green proves three things in a single request — egress really is tunnelled
 * through the gateway, the credential demuxed to the right twin, and the CA
 * install worked. Dialled outside the tunnel the host has no listener, so this
 * cannot pass by accident, which is what makes a receipt worth reading.
 */
export async function probeCanary(
  sandbox: Sandbox,
  canaryHost: string,
  expectedTwinId: string,
): Promise<void> {
  if (!HOSTNAME_RE.test(canaryHost)) {
    throw new ReceiptIntegrityError(
      `refusing to probe a malformed canary host from the control plane: ${JSON.stringify(canaryHost)}`,
      { phase: 'canary', verisSandboxId: expectedTwinId })
  }
  // A non-zero curl exit must surface as a ReceiptIntegrityError, not as the
  // raw command failure, so print a marker and inspect the output ourselves.
  const r = await sh(
    sandbox,
    `curl -sS --cacert ${CA_CERT_PATH} --max-time 20 https://${canaryHost}/ || echo __VERIS_CANARY_FAIL__`,
    45,
  ).catch((e: unknown) => ({ exitCode: 1, result: String(e) }))

  let body: { veris_sandbox_id?: string } = {}
  try { body = JSON.parse(r.result ?? '') } catch { /* handled below */ }
  if (body.veris_sandbox_id !== expectedTwinId) {
    throw new ReceiptIntegrityError(
      `canary probe failed: egress from this Daytona sandbox is not tunnelled through the ` +
      `Veris gateway (expected twin ${expectedTwinId}, canary answered: ` +
      `${(r.result || 'nothing').trim().slice(0, 200)})`,
      { phase: 'canary', verisSandboxId: expectedTwinId })
  }
}
