import { describe, expect, it } from 'vitest'
import { UsageError, formatReceipt, parseRunArgs, shellJoin, verdict } from '../../src/run'
import type { Receipt, ReceiptEntry } from '../../src/receipt'

const entry = (name: string, requests: number): ReceiptEntry => ({
  requests, controlUrl: `https://${name}.twin`, raw: null,
  entries: Array.from({ length: requests }, (_, i) => ({ method: 'POST', path: `/v1/${i}`, status: 200 })),
})
const receipt = (services: Record<string, number>): Receipt => ({
  services: Object.fromEntries(Object.entries(services).map(([n, r]) => [n, entry(n, r)])),
  mode: 'gateway', integrity: 'verified', leaks: [],
})

describe('parseRunArgs', () => {
  it('takes the command from after --, joined back into one shell line', () => {
    const o = parseRunArgs(['--repo', 'https://github.com/a/b', '--', 'pytest', 'tests/integration', '-k', 'stripe or github'])
    expect(o.repo).toBe('https://github.com/a/b')
    expect(o.command).toBe("pytest tests/integration -k 'stripe or github'")
  })

  it('refuses a run with no command', () => {
    expect(() => parseRunArgs(['--repo', 'x'])).toThrow(UsageError)
    expect(() => parseRunArgs(['--repo', 'x', '--'])).toThrow(/no command/)
  })

  it('collects repeatable flags and env pairs', () => {
    const o = parseRunArgs([
      '--require-service', 'stripe', '--require-service', 'github',
      '--allow-out', 'internal.corp', '--env', 'A=1', '--env', 'B=x=y', '--keep', '--timeout', '90',
      '--', 'make', 'test',
    ])
    expect(o.requireService).toEqual(['stripe', 'github'])
    expect(o.allowOut).toEqual(['internal.corp'])
    expect(o.env).toEqual({ A: '1', B: 'x=y' })
    expect(o.keep).toBe(true)
    expect(o.timeoutSeconds).toBe(90)
  })

  it('names the flag that is missing its value', () => {
    expect(() => parseRunArgs(['--setup', '--', 'x'])).toThrow('--setup needs a value')
    expect(() => parseRunArgs(['--env', 'NOEQ', '--', 'x'])).toThrow(/KEY=VALUE/)
    expect(() => parseRunArgs(['--timeout', '-3', '--', 'x'])).toThrow(/positive/)
  })

  it('rejects unknown flags and exclusive pairs', () => {
    expect(() => parseRunArgs(['--imag', 'x', '--', 'x'])).toThrow(/unknown option '--imag'/)
    expect(() => parseRunArgs(['--image', 'a', '--snapshot', 'b', '--', 'x'])).toThrow(/exclusive/)
  })

  it('defaults to uploading the cwd with no image and a 30-minute timeout', () => {
    const o = parseRunArgs(['--', 'npm', 'test'])
    expect(o.repo).toBeUndefined()
    expect(o.image).toBeUndefined()
    expect(o.timeoutSeconds).toBe(1800)
  })
})

describe('shellJoin', () => {
  it('leaves plain words alone and single-quotes the rest', () => {
    expect(shellJoin(['a', 'b c', "it's"])).toBe(`a 'b c' 'it'\\''s'`)
  })
})

describe('verdict', () => {
  it('a passing command whose twin saw traffic passes', () => {
    expect(verdict(0, receipt({ stripe: 3 }), [])).toEqual({ exitCode: 0, problems: [] })
  })

  it('a passing command whose twin saw NOTHING fails — a pass without a receipt is not a pass', () => {
    const v = verdict(0, receipt({ stripe: 0 }), [])
    expect(v.exitCode).toBe(1)
    expect(v.problems[0]).toMatch(/ZERO requests/)
  })

  it('a failing command keeps its own exit code', () => {
    expect(verdict(3, receipt({ stripe: 5 }), []).exitCode).toBe(3)
    expect(verdict(3, receipt({ stripe: 0 }), []).exitCode).toBe(3)
  })

  it('--require-service demands each named service, and traffic elsewhere does not count', () => {
    const v = verdict(0, receipt({ stripe: 4, github: 0 }), ['github'])
    expect(v.exitCode).toBe(1)
    expect(v.problems).toEqual([`'github' received ZERO requests — the code under test never called it`])
  })

  it('a required service the twin does not have is its own problem, not a silent zero', () => {
    expect(verdict(0, receipt({ stripe: 1 }), ['stripes']).problems[0]).toMatch(/no service named 'stripes'/)
  })
})

describe('formatReceipt', () => {
  it('lists every service with its requests', () => {
    const text = formatReceipt(receipt({ stripe: 2, github: 0 }), 'sbx_1')
    expect(text).toContain('twin sbx_1')
    expect(text).toContain('2 request(s) reached the twin')
    expect(text).toContain('stripe: 2 request(s)')
    expect(text).toContain('POST /v1/0 -> 200')
    expect(text).toContain('github: 0 request(s)')
  })
})
