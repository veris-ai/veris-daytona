// CA trust: which env vars point which client stacks at the system bundle,
// and the single tested install command.

/** Where the Veris CA certificate lands in the Daytona sandbox. This is the
 *  standard Debian drop-in directory, so any later `update-ca-certificates`
 *  rebuilds the bundle with our cert still included. */
export const CA_CERT_PATH = '/usr/local/share/ca-certificates/veris-ca.crt'

/** The distribution's own bundle, when it has one. */
export const SYSTEM_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'

/** Our CA alone, world-readable, written before anything needs it. */
export const VERIS_CA_FILE = '/tmp/veris-ca.crt'

/**
 * The public roots plus ours, concatenated by us.
 *
 * Every path-valued trust var points here rather than at SYSTEM_BUNDLE, because
 * `update-ca-certificates` is not always present — Daytona's default image does
 * not ship it — and a var pointing at a bundle that was never rebuilt trusts
 * everything except the one CA that matters. We write this file ourselves, so
 * it is correct whether or not the distribution has the tooling.
 */
export const VERIS_BUNDLE = '/tmp/veris-ca-bundle.crt'

/**
 * The trust variables injected into every sandbox at create time.
 *
 * This is the load-bearing half of CA trust: the gateway forges a leaf for each
 * vendor hostname, and a client that does not trust the Veris CA rejects it, so
 * without these (or the store install below) every HTTPS vendor call fails on
 * certificate validation.
 *
 * Every var is path-valued and points at VERIS_BUNDLE (public roots + ours, so
 * passthrough hosts keep verifying) — NODE_EXTRA_CA_CERTS included. That var is
 * additive, but only to Node's BAKED-IN Mozilla roots, never to the system
 * store — and on Daytona the leaf a client actually validates is signed by
 * Daytona's proxy CA (its proxy terminates TLS; see installCa's comment), which
 * lives in the system store and nowhere in Mozilla's roots. Point Node at the
 * single Veris cert and it can verify neither that leaf nor a directly served
 * gateway one behind it: UNABLE_TO_VERIFY_LEAF_SIGNATURE on every vendor call.
 * The bundle carries the system store (Daytona's CA with it) plus ours, so it
 * is the one file that works in both worlds.
 */
export function vendoredTrustEnv(): Record<string, string> {
  return {
    SSL_CERT_FILE: VERIS_BUNDLE,
    REQUESTS_CA_BUNDLE: VERIS_BUNDLE,
    CURL_CA_BUNDLE: VERIS_BUNDLE,
    GIT_SSL_CAINFO: VERIS_BUNDLE,
    AWS_CA_BUNDLE: VERIS_BUNDLE,
    CARGO_HTTP_CAINFO: VERIS_BUNDLE,
    DENO_CERT: VERIS_BUNDLE,
    PIP_CERT: VERIS_BUNDLE,
    npm_config_cafile: VERIS_BUNDLE,
    GRPC_DEFAULT_SSL_ROOTS_FILE_PATH: VERIS_BUNDLE,
    BUNDLE_SSL_CA_CERT: VERIS_BUNDLE,
    COMPOSER_CAFILE: VERIS_BUNDLE,
    HEX_CACERTS_PATH: VERIS_BUNDLE,
    JULIA_SSL_CA_ROOTS_PATH: VERIS_BUNDLE,
    NIX_SSL_CERT_FILE: VERIS_BUNDLE,
    PERL_LWP_SSL_CA_FILE: VERIS_BUNDLE,
    CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE: VERIS_BUNDLE,
    NODE_EXTRA_CA_CERTS: VERIS_BUNDLE,
  }
}

/**
 * Node is the one runtime the trust variables above cannot reach.
 *
 * Daytona overwrites NODE_EXTRA_CA_CERTS and SSL_CERT_FILE inside the sandbox
 * with its own CA file — right for clients that go through its proxy, which
 * terminates TLS with that CA. Node is not such a client: it ignores
 * HTTPS_PROXY, is forwarded to the gateway end to end, and the leaf it
 * validates is signed by the Veris CA, which Daytona's file lacks. Seen live:
 * plain `node` failed against a vendor host with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
 */

/**
 * Node's trust flag. NODE_EXTRA_CA_CERTS is Daytona's, and Node's baked-in
 * Mozilla roots do not know either CA — so switch Node to OpenSSL's store:
 * --use-openssl-ca loads SSL_CERT_FILE (Daytona's file) AND the system
 * certificate directory, where the store install puts our CA and the
 * distribution keeps the public roots. Verified live on Daytona's default
 * image: 200 from plain `node` with the flag, UNABLE_TO_VERIFY_LEAF_SIGNATURE
 * without it. Injected as NODE_OPTIONS, which Daytona leaves alone.
 */
export const NODE_TRUST_FLAG = '--use-openssl-ca'

/** NODE_OPTIONS with the trust flag appended to whatever the caller set. */
export function nodeOptionsWithTrust(existing?: string): string {
  const base = (existing ?? '').trim()
  if (base.split(/\s+/).includes(NODE_TRUST_FLAG)) return base
  return base ? `${base} ${NODE_TRUST_FLAG}` : NODE_TRUST_FLAG
}

/**
 * Second layer for Node: our CA appended to the file NODE_EXTRA_CA_CERTS
 * names, when writable and not already present. Idempotent (first base64 line
 * as fingerprint), never fatal, re-run after every restart. Not yet observed
 * to be sufficient on its own — see NODE_TRUST_FLAG.
 */
export const NODE_TRUST_APPEND_CMD =
  `([ -n "$NODE_EXTRA_CA_CERTS" ] && [ -s ${VERIS_CA_FILE} ] && [ -w "$NODE_EXTRA_CA_CERTS" ] && ` +
  `! grep -qxF "$(sed -n '/BEGIN CERTIFICATE/{n;p;q;}' ${VERIS_CA_FILE})" "$NODE_EXTRA_CA_CERTS" && ` +
  `{ echo; cat ${VERIS_CA_FILE}; } >> "$NODE_EXTRA_CA_CERTS") 2>/dev/null || true`

/**
 * The store-based install, for stacks that read a trust store rather than an
 * env var — a Java client honours no CA variable at all. Rebuilds the system
 * bundle with the Veris CA (already at CA_CERT_PATH), imports it into the JVM
 * cacerts (`|| true`: no Java → skipped), and adds it to NSS databases when
 * certutil exists.
 *
 * Entirely best-effort: it needs root and tooling the image may not have, which
 * is why VERIS_BUNDLE plus the trust variables — not this — is what actually
 * makes interception work.
 */
export const CA_INSTALL_CMD = [
  'update-ca-certificates',
  `(keytool -importcert -noprompt -cacerts -storepass changeit -alias veris -file ${CA_CERT_PATH} 2>/dev/null || true)`,
  '(command -v certutil >/dev/null 2>&1 && ' +
    'for db in $(find /home /root -maxdepth 4 -name "cert9.db" 2>/dev/null | xargs -r -n1 dirname); do ' +
    `certutil -A -n veris -t "C,," -i ${CA_CERT_PATH} -d "sql:$db" 2>/dev/null || true; done || true)`,
].join(' && ')

/**
 * Sanitize a server-served trust_env map before injecting it into the sandbox.
 * A control-plane response must never become arbitrary env-var injection, so
 * only known trust variables survive, and every value is forced to a
 * path-shaped string (the vars are all CA *file paths*). Unknown keys and
 * non-path values are dropped. Returns the vendored map when nothing valid
 * remains.
 */
export function sanitizeTrustEnv(served: Record<string, unknown> | undefined): Record<string, string> {
  const vendored = vendoredTrustEnv()
  // Start from the vendored map so a single bad or absent served value falls
  // back PER KEY to the known-good default, rather than dropping that variable
  // and leaving (e.g.) Python's requests with no CA bundle.
  const out: Record<string, string> = { ...vendored }
  for (const [k, val] of Object.entries(served ?? {})) {
    if (!(k in vendored)) continue // unknown key: never injected
    if (typeof val !== 'string') continue
    // Absolute path; allow the common path characters (incl. + and ~).
    if (!/^\/[\w./+~-]+$/.test(val)) continue
    out[k] = val
  }
  return out
}
