import { describe, it, expect } from 'vitest'
import {
  sanitizeTrustEnv, vendoredTrustEnv, nodeOptionsWithTrust, trustPrelude, bundledCaPatchScript,
  NODE_TRUST_FLAG, SYSTEM_BUNDLE, CA_CERT_PATH, VERIS_BUNDLE, VERIS_CA_FILE,
  BUNDLED_CA_FILES, BUNDLED_CA_PATCHED_MARKER,
} from '../../src/trust'

describe('vendoredTrustEnv', () => {
  it('points every var — NODE_EXTRA_CA_CERTS included — at the merged bundle', () => {
    // NODE_EXTRA_CA_CERTS extends Node's baked-in Mozilla roots, not the system
    // store, and the leaf a Daytona sandbox validates is signed by Daytona's
    // proxy CA — present only in the system store, hence only in the bundle.
    // Pointing this var at the lone Veris cert broke every Node vendor call
    // with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
    for (const [key, value] of Object.entries(vendoredTrustEnv())) {
      expect(value, key).toBe(VERIS_BUNDLE)
    }
  })
})

describe('sanitizeTrustEnv', () => {
  it('keeps known vars with path-shaped values', () => {
    const out = sanitizeTrustEnv({ SSL_CERT_FILE: '/custom/bundle.crt', NODE_EXTRA_CA_CERTS: CA_CERT_PATH })
    expect(out.SSL_CERT_FILE).toBe('/custom/bundle.crt')
    expect(out.NODE_EXTRA_CA_CERTS).toBe(CA_CERT_PATH)
  })
  it('drops unknown keys (no arbitrary env injection)', () => {
    const out = sanitizeTrustEnv({ EVIL: '/etc/passwd', LD_PRELOAD: '/x.so', SSL_CERT_FILE: SYSTEM_BUNDLE })
    expect(out).not.toHaveProperty('EVIL')
    expect(out).not.toHaveProperty('LD_PRELOAD')
    expect(out.SSL_CERT_FILE).toBe(SYSTEM_BUNDLE)
  })
  it('reverts a bad value to the vendored default PER KEY (never unsets it)', () => {
    const out = sanitizeTrustEnv({ SSL_CERT_FILE: '/ok/a.crt', CURL_CA_BUNDLE: 'x; rm -rf /', REQUESTS_CA_BUNDLE: 'relative' })
    expect(out.SSL_CERT_FILE).toBe('/ok/a.crt')                       // valid served value wins
    expect(out.CURL_CA_BUNDLE).toBe(vendoredTrustEnv().CURL_CA_BUNDLE) // bad value → vendored default
    expect(out.REQUESTS_CA_BUNDLE).toBe(vendoredTrustEnv().REQUESTS_CA_BUNDLE)
  })
  it('falls back to the full vendored map when nothing valid is served', () => {
    expect(sanitizeTrustEnv({ EVIL: 'x' })).toEqual(vendoredTrustEnv())
    expect(sanitizeTrustEnv(undefined)).toEqual(vendoredTrustEnv())
  })
})

describe('nodeOptionsWithTrust', () => {
  // Verified live: with the flag plain `node` → 200; without it,
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE. Daytona's CA file is read-only, so there
  // is no appending our CA to it — the flag plus the store install is the fix.
  it('is the bare flag when the caller set nothing', () => {
    expect(nodeOptionsWithTrust(undefined)).toBe(NODE_TRUST_FLAG)
    expect(nodeOptionsWithTrust('')).toBe(NODE_TRUST_FLAG)
  })
  it("appends to the caller's NODE_OPTIONS rather than replacing them", () => {
    expect(nodeOptionsWithTrust('--max-old-space-size=4096')).toBe(`--max-old-space-size=4096 ${NODE_TRUST_FLAG}`)
  })
  it('does not add the flag twice', () => {
    expect(nodeOptionsWithTrust(`--inspect ${NODE_TRUST_FLAG}`)).toBe(`--inspect ${NODE_TRUST_FLAG}`)
  })
  it('is not a served trust var: the control plane cannot set NODE_OPTIONS', () => {
    expect(sanitizeTrustEnv({ NODE_OPTIONS: '--require /evil.js' })).not.toHaveProperty('NODE_OPTIONS')
  })
})

describe('trustPrelude', () => {
  // The gap it fills: Daytona resets SSL_CERT_FILE, REQUESTS_CA_BUNDLE,
  // CURL_CA_BUNDLE and NODE_EXTRA_CA_CERTS inside the sandbox to its own CA
  // file, which cannot verify the gateway's leaf. A caller that hands a command
  // to a shell it did not build the env for has nowhere to put a map — measured
  // with the inherited value, `uv sync` dies with "invalid peer certificate:
  // UnknownIssuer".
  it('exports every variable the map carries', () => {
    const prelude = trustPrelude()
    for (const key of Object.keys(vendoredTrustEnv())) {
      expect(prelude, key).toContain(`export ${key}='${VERIS_BUNDLE}';`)
    }
  })

  it('is one line, so it can prefix a command', () => {
    expect(trustPrelude()).not.toContain('\n')
    expect(`${trustPrelude()} uv sync`).toContain(`export REQUESTS_CA_BUNDLE='${VERIS_BUNDLE}'; `)
  })

  it('quotes the value, so a served path cannot become a second command', () => {
    expect(trustPrelude({ SSL_CERT_FILE: "/tmp/x'; rm -rf /; '" }))
      .toBe(`export SSL_CERT_FILE='/tmp/x'\\''; rm -rf /; '\\''';`)
  })
})

describe('bundledCaPatchScript', () => {
  // stripe-python passes verify=stripe.ca_bundle_path, so none of the eighteen
  // trust variables reaches it and the first Stripe call fails with "Could not
  // verify Stripe's SSL certificate". The file itself is what has to change.
  it('looks for every bundle in the table, anchored at a path separator', () => {
    const script = bundledCaPatchScript()
    for (const { suffix } of BUNDLED_CA_FILES) expect(script, suffix).toContain(`-path '*/${suffix}'`)
    // No bare cacert.pem rule: that filename also names test fixtures and
    // client-auth material, which must not quietly gain a root.
    expect(script).not.toContain(`-path '*/cacert.pem'`)
  })

  it('skips a file that already carries our certificate, so re-running is free', () => {
    // Matched on a line of the base64 body, never the BEGIN line every
    // certificate in every bundle shares.
    expect(bundledCaPatchScript()).toContain(`marker=$(sed -n 2p ${VERIS_CA_FILE}`)
    expect(bundledCaPatchScript()).toContain('grep -qF "$marker" "$f" && continue')
  })

  it('appends, never replaces — a bundle holding only our root breaks everything else', () => {
    expect(bundledCaPatchScript()).toContain(`>> "$f"`)
  })

  it('does nothing at all when the CA is not on disk', () => {
    // Appending an empty file to every CA bundle in the image would be the
    // worst available no-op.
    expect(bundledCaPatchScript()).toContain(`[ -n "$marker" ] ||`)
  })

  it('reports each file it changed, so the caller can say what happened', () => {
    expect(bundledCaPatchScript()).toContain(`echo "${BUNDLED_CA_PATCHED_MARKER}$f"`)
  })

  it('prints a sentence, not a machine marker, because a person runs this script', () => {
    // `provision` hands out `sh /tmp/veris-patch-bundled-cas.sh` and whatever
    // it prints is what that caller sees. A bare __VERIS_PATCHED__ /path read
    // as debug output that escaped, while `run` — parsing the same lines —
    // showed prose. One act should not look like two.
    expect(BUNDLED_CA_PATCHED_MARKER).not.toMatch(/^__/)
    expect(BUNDLED_CA_PATCHED_MARKER).toMatch(/ $/)
  })

  it('says so when it patched nothing, since silence reads as "did it run?"', () => {
    const script = bundledCaPatchScript()
    expect(script).toContain('if [ "$n" -gt 0 ]; then echo "$n bundled CA file(s) patched"')
    expect(script).toContain('no bundled CA file needed patching')
  })

  it('counts inside the pipeline`s own subshell, or the count never survives', () => {
    // A pipeline's last stage runs in a subshell: `n` incremented in a bare
    // `while` after a pipe is gone by the time the summary would read it, so
    // the loop and the summary share one brace group.
    expect(bundledCaPatchScript()).toContain('| sort -u | { n=0')
  })
})
