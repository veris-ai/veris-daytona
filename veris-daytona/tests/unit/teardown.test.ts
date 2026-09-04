import { describe, expect, it } from 'vitest'
import { TEARDOWN_USAGE, parseTeardownArgs } from '../../src/teardown'
import { UsageError } from '../../src/run'
import { verisOwnsTwin, verisTwinId } from '../../src/daytona'
import type { Sandbox } from '@daytona/sdk'

/** A sandbox is only its labels as far as these two functions are concerned. */
const labelled = (labels: Record<string, string>) => ({ labels }) as unknown as Sandbox

describe('parseTeardownArgs', () => {
  it('takes the Daytona sandbox id as a positional', () => {
    expect(parseTeardownArgs(['dtn_1'])).toEqual({ sandboxId: 'dtn_1' })
  })

  it('refuses no id, and refuses more than one', () => {
    expect(() => parseTeardownArgs([])).toThrow(/no sandbox id given/)
    expect(() => parseTeardownArgs(['a', 'b'])).toThrow(/takes one sandbox id, got 2/)
  })

  it('rejects flags rather than deleting something named like one', () => {
    expect(() => parseTeardownArgs(['--all'])).toThrow(/unknown option '--all'/)
  })

  it('--help is the usage text itself, so the CLI can exit 0 on it', () => {
    expect(() => parseTeardownArgs(['--help'])).toThrow(UsageError)
    try { parseTeardownArgs(['-h']) } catch (e) { expect((e as Error).message).toBe(TEARDOWN_USAGE) }
  })
})

describe('the twin rule teardown honours', () => {
  // Same labels the wrapped delete() reads, which is the point: what teardown
  // says happened and what delete() did come from one fact.
  it('a twin this package created goes with the sandbox', () => {
    const sbx = labelled({ veris_twin_id: 'sbx_1', veris_owns_twin: 'true' })
    expect(verisTwinId(sbx)).toBe('sbx_1')
    expect(verisOwnsTwin(sbx)).toBe(true)
  })

  it('a twin we merely attached to is left alone', () => {
    const sbx = labelled({ veris_twin_id: 'sbx_1', veris_owns_twin: 'false' })
    expect(verisTwinId(sbx)).toBe('sbx_1')
    expect(verisOwnsTwin(sbx)).toBe(false)
  })

  it('a sandbox with no twin owns nothing — no label must not read as ownership', () => {
    expect(verisTwinId(labelled({ some: 'other' }))).toBeUndefined()
    expect(verisOwnsTwin(labelled({ some: 'other' }))).toBe(false)
    expect(verisOwnsTwin({} as Sandbox)).toBe(false)
  })

  it('a twin label with no ownership label is ours, as rehydrate has always read it', () => {
    expect(verisOwnsTwin(labelled({ veris_twin_id: 'sbx_1' }))).toBe(true)
  })
})
