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
 * The same variables as one POSIX `export` prelude, to prefix a command with.
 *
 * The map above is the right shape when you control the process's environment.
 * A caller that does not — anything handing a command to a shell whose env it
 * did not build — has nowhere to put a map, and the command inherits Daytona's
 * overwritten SSL_CERT_FILE / REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE /
 * NODE_EXTRA_CA_CERTS instead. Measured with the inherited value: `uv sync`
 * dies with "invalid peer certificate: UnknownIssuer". Prefixing this makes
 * the command's own shell put the Veris bundle back:
 *
 *   sandbox.process.executeCommand(`${trustPrelude()} ${yourCommand}`)
 *
 * Values are single-quoted, so the string stays one safe command line whatever
 * the control plane served.
 */
export function trustPrelude(env: Record<string, string> = vendoredTrustEnv()): string {
  return Object.entries(env)
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}';`)
    .join(' ')
}

/**
 * CA bundles that SDKs ship INSIDE the code under test, as slash-anchored path
 * suffixes.
 *
 * No trust variable reaches these. stripe-python passes
 * `verify=stripe.ca_bundle_path` explicitly, so all eighteen variables above
 * are irrelevant to it and the first Stripe call dies with "Could not verify
 * Stripe's SSL certificate" — the gateway's forged leaf is signed by a CA that
 * file has never heard of. Appending our CA to the file keeps the SDK on the
 * code path that ships; the bundle merely holds one more root.
 *
 * The table is the veris CLI's (internal/bundlescan), for the reason it gives
 * there: matched as a path SUFFIX because site-packages prefixes vary per
 * image and the tail does not, and deliberately with no bare `cacert.pem`
 * rule, because that filename also names test fixtures and client-auth
 * material that must not quietly gain a root.
 */
export const BUNDLED_CA_FILES: readonly { sdk: string; suffix: string }[] = [
  { sdk: 'pip (vendored certifi)', suffix: 'pip/_vendor/certifi/cacert.pem' },
  { sdk: 'certifi', suffix: 'certifi/cacert.pem' },
  { sdk: 'botocore', suffix: 'botocore/cacert.pem' },
  // Matches both stripe-python's site-packages layout and the stripe-ruby gem.
  { sdk: 'stripe', suffix: 'stripe/data/ca-certificates.crt' },
  { sdk: 'httplib2', suffix: 'httplib2/cacerts.txt' },
]

/** Where the patch script is written inside the sandbox, so anything that can
 *  run a shell command — a test harness, an agent, a person over ssh — can
 *  re-run it after installing dependencies without holding this SDK. */
export const BUNDLED_CA_PATCH_SCRIPT = '/tmp/veris-patch-bundled-cas.sh'

/**
 * What the script prints per patched file, so the caller can report what
 * happened rather than infer it from an exit code.
 *
 * A sentence rather than a machine marker, because both routes to this script
 * are read by a person. `provision` tells a caller to run `sh
 * /tmp/veris-patch-bundled-cas.sh` themselves, and whatever the script prints
 * is what they see — a bare `__VERIS_PATCHED__ /path` reads as debug output
 * that escaped. `patchBundledCas()` parses the paths back off this same
 * constant, and cli.ts prints the same sentence for the SDK route, so the
 * prose a human reads and the list a program gets cannot drift apart.
 */
export const BUNDLED_CA_PATCHED_MARKER = 'the Veris CA was appended to '

/**
 * The script that finds those bundles and appends the Veris CA to each.
 *
 * Meant to run AFTER dependencies are installed, and to be re-run: the bundles
 * do not exist at create time, and an agent installs more of them mid-session,
 * so there is no create-time moment that covers either. Idempotent by
 * construction — a file already carrying our certificate is skipped, matched
 * on a line of its base64 body rather than on the BEGIN line every certificate
 * shares.
 *
 * Appending in place, where the CLI over-mounts a patched copy: a Daytona
 * sandbox offers no bind mounts and the container is disposable, so editing
 * the file is the equivalent move. Unwritable files are skipped rather than
 * sudo'd — a root-owned bundle in the system Python is rarely the one the
 * application's virtualenv reads, and silently rewriting system trust is a
 * larger act than this warrants.
 */
export function bundledCaPatchScript(): string {
  const find = BUNDLED_CA_FILES
    .map((f) =>
      `find / -xdev \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o ` +
      `-path '*/${f.suffix}' -type f -print 2>/dev/null`)
    .join('; ')
  return [
    `marker=$(sed -n 2p ${VERIS_CA_FILE} 2>/dev/null)`,
    // No CA on disk means nothing to append, and appending nothing to every
    // bundle in the image would be the worst available no-op.
    `[ -n "$marker" ] || { echo "no ${VERIS_CA_FILE} to append" >&2; exit 1; }`,
    // The whole loop is one brace group at the end of the pipe so `n` survives
    // to the summary: a pipeline's last stage is a subshell, and a counter
    // incremented inside a bare `while` would be gone by the time we report it.
    `{ ${find}; } | sort -u | { n=0`,
    `while IFS= read -r f; do`,
    `  [ -w "$f" ] || continue`,
    `  grep -qF "$marker" "$f" && continue`,
    `  { printf '\\n'; cat ${VERIS_CA_FILE}; } >> "$f" || continue`,
    `  n=$((n+1))`,
    `  echo "${BUNDLED_CA_PATCHED_MARKER}$f"`,
    `done`,
    // Silence is the common case and it reads as "did that even run?", so say
    // so. patchBundledCas() keeps only the lines above, so this costs it
    // nothing.
    `if [ "$n" -gt 0 ]; then echo "$n bundled CA file(s) patched"`,
    `else echo "no bundled CA file needed patching — no SDK that ships its own is installed here, or they already trust the Veris CA"; fi`,
    `}`,
  ].join('\n')
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
 * Mozilla roots know neither CA — so switch Node to OpenSSL's store:
 * --use-openssl-ca loads SSL_CERT_FILE (Daytona's file) AND the system
 * certificate directory, where CA_INSTALL_CMD puts our CA and the distribution
 * keeps the public roots. Injected as NODE_OPTIONS, which Daytona leaves alone.
 *
 * Verified live on Daytona's default image (uid 1001, passwordless sudo,
 * update-ca-certificates present): 200 from plain `node` with the flag and
 * our CA in /etc/ssl/certs; UNABLE_TO_VERIFY_LEAF_SIGNATURE without the flag.
 * So this leans on the store install succeeding. There is no second route:
 * Daytona's CA file is on a read-only mount, so appending our CA to it — the
 * obvious alternative — fails for root too.
 */
export const NODE_TRUST_FLAG = '--use-openssl-ca'

/** NODE_OPTIONS with the trust flag appended to whatever the caller set. */
export function nodeOptionsWithTrust(existing?: string): string {
  const base = (existing ?? '').trim()
  if (base.split(/\s+/).includes(NODE_TRUST_FLAG)) return base
  return base ? `${base} ${NODE_TRUST_FLAG}` : NODE_TRUST_FLAG
}

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
