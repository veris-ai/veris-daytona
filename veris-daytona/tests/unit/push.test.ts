import { describe, expect, it } from 'vitest'
import { PUSH_USAGE, parsePushArgs } from '../../src/push'
import { UPLOAD_EXCLUDES, UsageError, WORK_SUBDIR } from '../../src/run'

describe('parsePushArgs', () => {
  it('takes the Daytona sandbox id as a positional', () => {
    expect(parsePushArgs(['dtn_1'])).toEqual({ sandboxId: 'dtn_1' })
  })

  it('defaults to uploading the current directory, with no repo named', () => {
    const o = parsePushArgs(['dtn_1'])
    expect(o.repo).toBeUndefined()
    expect(o.ref).toBeUndefined()
  })

  it('clones when given a repo, and takes a branch with it', () => {
    const o = parsePushArgs(['dtn_1', '--repo', 'https://github.com/a/b', '--ref', 'main'])
    expect(o.sandboxId).toBe('dtn_1')
    expect(o.repo).toBe('https://github.com/a/b')
    expect(o.ref).toBe('main')
  })

  it('reads the id whichever side of the flags it is written on', () => {
    expect(parsePushArgs(['--repo', 'https://x/y', 'dtn_1']).sandboxId).toBe('dtn_1')
  })

  it('refuses a --ref with nothing to clone, rather than ignoring it', () => {
    // An upload has no branch. Accepting the flag and dropping it leaves the
    // caller believing they pushed one.
    expect(() => parsePushArgs(['dtn_1', '--ref', 'main'])).toThrow(/--ref only means something with --repo/)
  })

  it('refuses no id, and refuses more than one', () => {
    expect(() => parsePushArgs([])).toThrow(/no sandbox id given/)
    expect(() => parsePushArgs(['a', 'b'])).toThrow(/takes one sandbox id, got 2/)
  })

  it('names the flag that is missing its value', () => {
    expect(() => parsePushArgs(['dtn_1', '--repo'])).toThrow('--repo needs a value')
    expect(() => parsePushArgs(['dtn_1', '--repo', '--ref'])).toThrow('--repo needs a value')
  })

  it('rejects unknown flags rather than reading them as an id', () => {
    expect(() => parsePushArgs(['dtn_1', '--rep', 'x'])).toThrow(/unknown option '--rep'/)
  })

  it('--help is the usage text itself, so the CLI can exit 0 on it', () => {
    expect(() => parsePushArgs(['--help'])).toThrow(UsageError)
    try { parsePushArgs(['-h']) } catch (e) { expect((e as Error).message).toBe(PUSH_USAGE) }
  })
})

describe('PUSH_USAGE', () => {
  it('lists the excludes, because the trial had to retype all fifteen by hand', () => {
    for (const x of UPLOAD_EXCLUDES) expect(PUSH_USAGE, `undocumented exclude: ${x}`).toContain(x)
  })

  it('names the same directory provision reports as workDir', () => {
    // The two chain only if they agree on where code goes, and the caller
    // should not have to carry the path between the commands to find out.
    expect(PUSH_USAGE).toContain(WORK_SUBDIR)
    expect(PUSH_USAGE).toContain('workDir')
  })

  it('says why the verb exists, since the obvious question is "why not daytona cp"', () => {
    expect(PUSH_USAGE).toMatch(/no upload, copy or sync command/)
  })
})
