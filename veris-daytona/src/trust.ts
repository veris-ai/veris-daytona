// CA trust: which env vars point which client stacks at the system bundle,
// and the single tested install command.

/** Where the Veris CA certificate lands in the Daytona sandbox. This is the
 *  standard Debian drop-in directory, so any later `update-ca-certificates`
 *  rebuilds the bundle with our cert still included. */
export const CA_CERT_PATH = '/usr/local/share/ca-certificates/veris-ca.crt'

/** The rebuilt system bundle every path-valued trust var points at. */
export const SYSTEM_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'

/**
 * The vendored trust-env fallback. The control plane serves the same map
 * (`trust_env` in the egress-credential response) as the source of truth so
 * new tools get covered by a control-plane deploy; the served copy wins.
 *
 * Every var is path-valued and points at the SYSTEM bundle (Veris CA + all
 * public roots — passthrough hosts keep verifying), except NODE_EXTRA_CA_CERTS
 * which is additive by design and takes the single cert.
 */
export function vendoredTrustEnv(): Record<string, string> {
  return {
    SSL_CERT_FILE: SYSTEM_BUNDLE,
    REQUESTS_CA_BUNDLE: SYSTEM_BUNDLE,
    CURL_CA_BUNDLE: SYSTEM_BUNDLE,
    GIT_SSL_CAINFO: SYSTEM_BUNDLE,
    AWS_CA_BUNDLE: SYSTEM_BUNDLE,
    CARGO_HTTP_CAINFO: SYSTEM_BUNDLE,
    DENO_CERT: SYSTEM_BUNDLE,
    PIP_CERT: SYSTEM_BUNDLE,
    npm_config_cafile: SYSTEM_BUNDLE,
    GRPC_DEFAULT_SSL_ROOTS_FILE_PATH: SYSTEM_BUNDLE,
    BUNDLE_SSL_CA_CERT: SYSTEM_BUNDLE,
    COMPOSER_CAFILE: SYSTEM_BUNDLE,
    HEX_CACERTS_PATH: SYSTEM_BUNDLE,
    JULIA_SSL_CA_ROOTS_PATH: SYSTEM_BUNDLE,
    NIX_SSL_CERT_FILE: SYSTEM_BUNDLE,
    PERL_LWP_SSL_CA_FILE: SYSTEM_BUNDLE,
    CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE: SYSTEM_BUNDLE,
    NODE_EXTRA_CA_CERTS: CA_CERT_PATH,
  }
}

/** Probe that the template can host the CA install at all. Prints ok/missing. */
export const CA_TOOLING_PROBE = 'command -v update-ca-certificates >/dev/null 2>&1 && echo ok || echo missing'

/**
 * The one root command of gateway mode. Rebuilds the system bundle with the
 * Veris CA (already written to CA_CERT_PATH), then best-effort extras:
 * the JVM cacerts import (`|| true`: no Java → skipped), and NSS databases
 * for browser stacks when certutil exists (never fatal).
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
