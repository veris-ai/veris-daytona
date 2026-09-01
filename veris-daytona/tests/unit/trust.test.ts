import { describe, it, expect } from 'vitest'
import { sanitizeTrustEnv, vendoredTrustEnv, SYSTEM_BUNDLE, CA_CERT_PATH, VERIS_BUNDLE } from '../../src/trust'

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
