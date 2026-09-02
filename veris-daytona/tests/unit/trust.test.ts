import { describe, it, expect } from 'vitest'
import { sanitizeTrustEnv, vendoredTrustEnv, nodeOptionsWithTrust, NODE_TRUST_FLAG, NODE_TRUST_APPEND_CMD, SYSTEM_BUNDLE, CA_CERT_PATH, VERIS_BUNDLE, VERIS_CA_FILE } from '../../src/trust'

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

describe('NODE_TRUST_APPEND_CMD', () => {
  // Daytona overwrites NODE_EXTRA_CA_CERTS (and SSL_CERT_FILE) in the sandbox
  // with its own CA file, so no variable we send reaches Node. Our CA goes
  // into that file instead. Verified live: plain `node` → 200, no prefix.
  it('appends the Veris CA to the file NODE_EXTRA_CA_CERTS names', () => {
    expect(NODE_TRUST_APPEND_CMD).toContain('"$NODE_EXTRA_CA_CERTS"')
    expect(NODE_TRUST_APPEND_CMD).toContain(`cat ${VERIS_CA_FILE}`)
    expect(NODE_TRUST_APPEND_CMD).toContain('>> "$NODE_EXTRA_CA_CERTS"')
  })
  it('is guarded: only a writable file, only once, never fatal', () => {
    expect(NODE_TRUST_APPEND_CMD).toContain('[ -w "$NODE_EXTRA_CA_CERTS" ]')
    expect(NODE_TRUST_APPEND_CMD).toContain('! grep -qxF') // fingerprint already present → no-op
    expect(NODE_TRUST_APPEND_CMD.endsWith('|| true')).toBe(true)
  })
})

describe('nodeOptionsWithTrust', () => {
  // Verified live: with the flag plain `node` → 200; without it, with only
  // the append, UNABLE_TO_VERIFY_LEAF_SIGNATURE. The flag is load-bearing.
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
