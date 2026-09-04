import { describe, expect, it } from 'vitest'
import { EXEC_USAGE, parseExecArgs } from '../../src/exec'
import { DEFAULT_TIMEOUT_SECONDS, TIMED_OUT_EXIT, UsageError, WORK_SUBDIR, commandEnv } from '../../src/run'
import { vendoredTrustEnv } from '../../src/trust'

describe('parseExecArgs', () => {
  it('takes the id as a positional and the command from after --', () => {
    const o = parseExecArgs(['dtn_1', '--', 'pytest', 'tests/integration', '-k', 'stripe or github'])
    expect(o.sandboxId).toBe('dtn_1')
    expect(o.command).toBe("pytest tests/integration -k 'stripe or github'")
  })

  it('leaves the command`s own flags to the command, which is what -- is for', () => {
    // Without the separator `exec box -- ls -h` would print our help instead
    // of listing anything.
    const o = parseExecArgs(['dtn_1', '--', 'ls', '-h', '--timeout', '5'])
    expect(o.command).toBe('ls -h --timeout 5')
    expect(o.timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS)
  })

  it('collects repeatable env pairs, a cwd and a timeout', () => {
    const o = parseExecArgs([
      'dtn_1', '--cwd', '/srv/app', '--env', 'A=1', '--env', 'B=x=y', '--timeout', '90', '--', 'make', 'test',
    ])
    expect(o.cwd).toBe('/srv/app')
    expect(o.env).toEqual({ A: '1', B: 'x=y' })
    expect(o.timeoutSeconds).toBe(90)
  })

  it('defaults the cwd to nothing here, so cli.ts can resolve provision`s workDir live', () => {
    // The path depends on the sandbox's own home, which is only knowable with
    // the sandbox in hand. An unset cwd is the signal to go and ask.
    expect(parseExecArgs(['dtn_1', '--', 'true']).cwd).toBeUndefined()
  })

  it('refuses no id, more than one, and no command', () => {
    expect(() => parseExecArgs(['--', 'true'])).toThrow(/no sandbox id given/)
    expect(() => parseExecArgs(['a', 'b', '--', 'true'])).toThrow(/takes one sandbox id, got 2/)
    expect(() => parseExecArgs(['dtn_1'])).toThrow(/no command given/)
    expect(() => parseExecArgs(['dtn_1', '--'])).toThrow(/no command given/)
  })

  it('names the flag that is missing its value', () => {
    expect(() => parseExecArgs(['dtn_1', '--cwd', '--', 'true'])).toThrow('--cwd needs a value')
    expect(() => parseExecArgs(['dtn_1', '--env', 'NOEQ', '--', 'true'])).toThrow(/KEY=VALUE/)
    expect(() => parseExecArgs(['dtn_1', '--timeout', '0', '--', 'true'])).toThrow(/positive/)
  })

  it('rejects unknown flags rather than reading them as an id', () => {
    expect(() => parseExecArgs(['dtn_1', '--cw', '/x', '--', 'true'])).toThrow(/unknown option '--cw'/)
  })

  it('--help is the usage text itself, so the CLI can exit 0 on it', () => {
    expect(() => parseExecArgs(['--help'])).toThrow(UsageError)
    try { parseExecArgs(['-h']) } catch (e) { expect((e as Error).message).toBe(EXEC_USAGE) }
  })
})

describe('the environment exec runs a command with', () => {
  it('is the trust environment, with --env layered on top of it', () => {
    // The reason the verb exists: `daytona exec` has no --env flag at all, so
    // every command through it inherits Daytona's own CA file and fails on the
    // gateway's certificate unless the caller retypes the prelude each time.
    const { env } = parseExecArgs(['dtn_1', '--env', 'PYTHONUNBUFFERED=1', '--', 'true'])
    const merged = commandEnv(vendoredTrustEnv(), env)
    expect(merged.SSL_CERT_FILE).toBe(vendoredTrustEnv().SSL_CERT_FILE)
    expect(merged.PYTHONUNBUFFERED).toBe('1')
  })

  it('lets the caller override a trust variable, since --env is applied last', () => {
    const { env } = parseExecArgs(['dtn_1', '--env', 'SSL_CERT_FILE=/etc/mine.pem', '--', 'true'])
    expect(commandEnv(vendoredTrustEnv(), env).SSL_CERT_FILE).toBe('/etc/mine.pem')
  })
})

describe('EXEC_USAGE', () => {
  it('names the default working directory, so it can be read without running it', () => {
    expect(EXEC_USAGE).toContain(WORK_SUBDIR)
    expect(EXEC_USAGE).toContain('workDir')
  })

  it('documents the timeout default and the status a timeout reports', () => {
    expect(EXEC_USAGE).toContain(String(DEFAULT_TIMEOUT_SECONDS))
    expect(EXEC_USAGE).toContain(String(TIMED_OUT_EXIT))
  })

  it('sends the verdict elsewhere rather than growing a second one here', () => {
    // The `veris` CLI owns what a receipt proves. A duplicate here is how this
    // package drifted the first time.
    expect(EXEC_USAGE).toMatch(/No receipt is read and no verdict is passed/)
    expect(EXEC_USAGE).toContain('veris sandbox trace --since')
  })
})
