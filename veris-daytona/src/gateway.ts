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
import { CA_CERT_PATH, CA_INSTALL_CMD, SYSTEM_BUNDLE, VERIS_BUNDLE, VERIS_CA_FILE } from './trust'

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
export function gatewayProxyUrl(credential: {
  http_proxy_url?: string
  connect_address?: string
  username: string
}): string {
  // The gateway's own URL wins when it serves one. It knows its auth format —
  // the password is the twin id, not a placeholder — and a locally built URL
  // that guesses wrong authenticates as nobody.
  if (credential.http_proxy_url) return assertProxyUrl(credential.http_proxy_url)

  if (!credential.connect_address || !HOSTPORT_RE.test(credential.connect_address)) {
    throw new VerisError(
      `the control plane returned a malformed gateway address: ` +
      `${JSON.stringify(credential.connect_address)} (expected host:port)`,
      { phase: 'credential-mint' })
  }
  return `http://${encodeURIComponent(credential.username)}:x@${credential.connect_address}`
}

/**
 * A proxy URL from the control plane, before it becomes every client's egress
 * configuration. Untrusted input: it must parse, name a port, and speak a
 * scheme Daytona accepts — it rejects anything but http/https outright.
 */
function assertProxyUrl(raw: string): string {
  let u: URL
  try { u = new URL(raw) } catch {
    throw new VerisError(
      `the control plane returned an unparseable gateway proxy URL: ${JSON.stringify(raw)}`,
      { phase: 'credential-mint' })
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new VerisError(
      `the gateway proxy URL uses scheme "${u.protocol.replace(':', '')}", and Daytona accepts ` +
      `only http or https outbound proxies`,
      { phase: 'credential-mint' })
  }
  if (!u.hostname || !u.port) {
    throw new VerisError(
      `the gateway proxy URL is missing a host or port: ${JSON.stringify(raw)}`,
      { phase: 'credential-mint' })
  }
  return raw
}

/**
 * Make the gateway's CA trusted, without requiring anything of the image.
 *
 * Defensive rather than load-bearing on Daytona today, and the distinction is
 * worth recording. Daytona's own proxy terminates TLS with a certificate signed
 * by ITS CA — already trusted in the image — and re-originates to the gateway,
 * so the client never validates our forged leaf. Verified: a vendor call
 * succeeds with --cacert naming only Daytona's CA.
 *
 * We install ours regardless, because the day Daytona tunnels CONNECT
 * end-to-end (the ordinary behaviour for an HTTP proxy) the gateway's leaf
 * reaches the client directly and nothing works without it. One upload and one
 * shell command against a total outage is a trade worth making.
 *
 * The obvious approach — drop the cert in /usr/local/share/ca-certificates and
 * run update-ca-certificates — needs root AND that tool, and Daytona's default
 * image has neither. So the artefact is a bundle we build ourselves at a
 * world-writable path: the distribution's roots (when it has any) plus ours.
 *
 * Daytona overrides the best-known trust variables with its own CA, correctly
 * for its proxy. The dozen it does not set still point at this bundle, which
 * carries both CAs and every public root — so those tools verify rather than
 * break. Node is the exception that makes ours load-bearing today: it ignores
 * HTTPS_PROXY, is forwarded end to end, and validates OUR leaf with Daytona's
 * file — see NODE_TRUST_FLAG in trust.ts for how it is pointed at the bundle.
 *
 * The system-store install still runs when it can, for anything that reads the
 * store directly rather than honouring the variables. It is best-effort.
 */
export async function installCa(sandbox: Sandbox, caPem: string): Promise<void> {
  await sandbox.fs.uploadFile(Buffer.from(caPem, 'utf8'), VERIS_CA_FILE)

  const script = [
    `chmod 0644 ${VERIS_CA_FILE}`,
    // Public roots first so they keep working; ours appended. `cat` of a
    // missing file is tolerated — an image with no roots at all still gets a
    // bundle containing the one CA that matters here.
    `{ cat ${SYSTEM_BUNDLE} 2>/dev/null; cat ${VERIS_CA_FILE}; } > ${VERIS_BUNDLE}`,
    `chmod 0644 ${VERIS_BUNDLE}`,
    // Best-effort, for the stacks that read a store rather than a variable:
    // the system bundle, the JVM truststore, and NSS databases. All of it needs
    // root and tooling that may not be there, so none of it is load-bearing —
    // but a Java client honours no CA env var at all, so where we CAN do it,
    // we should.
    `SUDO=; [ "$(id -u)" = 0 ] || SUDO="sudo -n"`,
    `($SUDO install -m 0644 -D ${VERIS_CA_FILE} ${CA_CERT_PATH} 2>/dev/null && ` +
      `$SUDO sh -c ${shellQuote(CA_INSTALL_CMD)} 2>/dev/null) || true`,
    // Daytona points NODE_EXTRA_CA_CERTS at its own CA file, and Node reads
    // that file whatever else is set. Where it is writable, our CA goes in
    // too — one more root, nothing removed — so Node verifies the gateway
    // leaf even when a caller's tooling has clobbered NODE_OPTIONS.
    `([ -n "$NODE_EXTRA_CA_CERTS" ] && [ -w "$NODE_EXTRA_CA_CERTS" ] && ` +
      `! grep -qxF "$(sed -n '/BEGIN CERTIFICATE/{n;p;q;}' ${VERIS_CA_FILE})" "$NODE_EXTRA_CA_CERTS" && ` +
      `{ echo; cat ${VERIS_CA_FILE}; } >> "$NODE_EXTRA_CA_CERTS") 2>/dev/null || true`,
    // The bundle is the load-bearing one: fail loudly if it is not there.
    `[ -s ${VERIS_BUNDLE} ] && echo __VERIS_CA_OK__`,
  ].join('; ')

  const r = await sh(sandbox, script, 120).catch((e: unknown) => ({ exitCode: 1, result: String(e) }))
  if (!(r.result ?? '').includes('__VERIS_CA_OK__')) {
    throw new SnapshotUnsupportedError(
      `could not assemble a CA bundle at ${VERIS_BUNDLE}, so the gateway's certificates ` +
      `cannot be trusted (${(r.result ?? '').trim().slice(0, 200)})`,
      { phase: 'ca-install' })
  }
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
    `curl -sS --cacert ${VERIS_BUNDLE} --max-time 20 https://${canaryHost}/ || echo __VERIS_CANARY_FAIL__`,
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
