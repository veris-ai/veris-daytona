import { describe, expect, it } from 'vitest'
import {
  AUTO_DELETE_MINUTES, AUTO_STOP_MINUTES, PROVISION_TTL_MINUTES, PROVISION_USAGE,
  parseProvisionArgs, provisionJson, provisionResult,
} from '../../src/provision'
import { UsageError } from '../../src/run'
import { BUNDLED_CA_PATCH_SCRIPT, VERIS_BUNDLE } from '../../src/trust'

const facts = {
  daytonaSandboxId: 'dtn_1',
  verisSandboxId: 'sbx_1',
  verisEnvironmentId: 'env_1',
  workDir: '/home/daytona/veris-run',
  trustEnv: { SSL_CERT_FILE: VERIS_BUNDLE, REQUESTS_CA_BUNDLE: VERIS_BUNDLE },
  services: ['stripe', 'github'],
  expiresAt: '2026-09-04T12:00:00.000Z',
}

describe('parseProvisionArgs', () => {
  it('requires --sandbox, because a box with no twin is not worth provisioning', () => {
    expect(() => parseProvisionArgs([])).toThrow(/--sandbox is required/)
    expect(parseProvisionArgs(['--sandbox', 'sbx_1']).sandbox).toBe('sbx_1')
  })

  it('collects repeatable flags and env pairs', () => {
    const o = parseProvisionArgs([
      '--sandbox', 'sbx_1', '--image', 'python:3.12',
      '--allow-out', 'internal.corp', '--allow-out', 'other.corp',
      '--env', 'A=1', '--env', 'B=x=y',
    ])
    expect(o.image).toBe('python:3.12')
    expect(o.allowOut).toEqual(['internal.corp', 'other.corp'])
    expect(o.env).toEqual({ A: '1', B: 'x=y' })
  })

  it('names the flag that is missing its value', () => {
    expect(() => parseProvisionArgs(['--sandbox'])).toThrow('--sandbox needs a value')
    expect(() => parseProvisionArgs(['--sandbox', 's', '--env', 'NOEQ'])).toThrow(/KEY=VALUE/)
  })

  it('rejects unknown flags and exclusive pairs', () => {
    expect(() => parseProvisionArgs(['--sandbox', 's', '--imag', 'x'])).toThrow(/unknown option '--imag'/)
    expect(() => parseProvisionArgs(['--sandbox', 's', '--image', 'a', '--snapshot', 'b'])).toThrow(/exclusive/)
  })

  it('tells a `run` flag it is in the wrong verb, rather than calling it a typo', () => {
    // The flags did not disappear, they moved — an "unknown option" here would
    // send someone hunting for a spelling mistake they did not make.
    expect(() => parseProvisionArgs(['--sandbox', 's', '--setup', 'npm ci'])).toThrow(/--setup is a `run` flag/)
    expect(() => parseProvisionArgs(['--sandbox', 's', '--require-service', 'stripe'])).toThrow(/`veris` CLI/)
    expect(() => parseProvisionArgs(['--sandbox', 's', '--keep'])).toThrow(/teardown/)
    expect(() => parseProvisionArgs(['--sandbox', 's', '--environment', 'env_1'])).toThrow(/comes from the twin/)
  })

  it('refuses a command after --, since provision runs nothing', () => {
    expect(() => parseProvisionArgs(['--sandbox', 's', '--', 'pytest'])).toThrow(/nothing to put after/)
  })

  it('--help is the usage text itself, so the CLI can exit 0 on it', () => {
    expect(() => parseProvisionArgs(['--help'])).toThrow(UsageError)
    try { parseProvisionArgs(['-h']) } catch (e) { expect((e as Error).message).toBe(PROVISION_USAGE) }
  })
})

describe('provisionResult', () => {
  it('carries what a caller would otherwise have to guess', () => {
    const r = provisionResult(facts)
    expect(r.daytonaSandboxId).toBe('dtn_1')
    expect(r.verisSandboxId).toBe('sbx_1')
    expect(r.verisEnvironmentId).toBe('env_1')
    expect(r.workDir).toBe('/home/daytona/veris-run')
    expect(r.services).toEqual(['stripe', 'github'])
    expect(r.caBundlePath).toBe(VERIS_BUNDLE)
    expect(r.trustEnv.SSL_CERT_FILE).toBe(VERIS_BUNDLE)
  })

  it('says the twin is not ours, because provision only ever attaches', () => {
    // Teardown reads the sandbox label rather than this field, but a caller
    // reads this one — and it must not promise a twin delete that will not come.
    expect(provisionResult(facts).ownsTwin).toBe(false)
  })

  it('serves the trust variables as a shell prelude too, for a caller with no env map', () => {
    const r = provisionResult(facts)
    expect(r.trustPrelude).toContain(`export SSL_CERT_FILE='${VERIS_BUNDLE}';`)
    expect(r.trustPrelude).toContain(`export REQUESTS_CA_BUNDLE='${VERIS_BUNDLE}';`)
  })

  it('names the in-sandbox script for the bundled CAs, which is the whole patch story', () => {
    // The script is uploaded at create, so a caller that installed its own
    // dependencies patches them with one line of shell and no extra verb.
    expect(provisionResult(facts).patchBundledCasCommand).toBe(`sh ${BUNDLED_CA_PATCH_SCRIPT}`)
  })

  it('reports the lifetime it actually asked Daytona for', () => {
    const r = provisionResult(facts)
    expect(r.expiresAt).toBe('2026-09-04T12:00:00.000Z')
    expect(r.autoStopMinutes).toBe(AUTO_STOP_MINUTES)
    expect(r.autoDeleteMinutes).toBe(AUTO_DELETE_MINUTES)
  })
})

describe('the sandbox lifetime', () => {
  it('stops, then deletes, then expires — in that order, or the later one never happens', () => {
    expect(AUTO_STOP_MINUTES).toBeLessThan(AUTO_DELETE_MINUTES)
    expect(AUTO_STOP_MINUTES + AUTO_DELETE_MINUTES).toBeLessThan(PROVISION_TTL_MINUTES)
  })
})

describe('provisionJson', () => {
  it('is one parseable object, which is the point of printing it alone on stdout', () => {
    const parsed = JSON.parse(provisionJson(provisionResult(facts))) as Record<string, unknown>
    expect(parsed.daytonaSandboxId).toBe('dtn_1')
    expect(parsed.verisSandboxId).toBe('sbx_1')
  })

  it('documents every field it prints in the usage text', () => {
    // A field a caller cannot look up is a field they have to guess at.
    for (const key of Object.keys(provisionResult(facts))) {
      expect(PROVISION_USAGE, `undocumented field: ${key}`).toContain(key)
    }
  })
})
