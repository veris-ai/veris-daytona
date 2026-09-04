import { describe, expect, it } from 'vitest'
import { DaytonaError, DaytonaForbiddenError, DaytonaNotFoundError } from '@daytona/sdk'
import {
  TEARDOWN_USAGE, isPermissionDenied, parseTeardownArgs, sandboxBrakes, teardownRefusedMessage,
} from '../../src/teardown'
import { UsageError } from '../../src/run'
import { verisOwnsTwin, verisTwinId } from '../../src/daytona'
import { DELETE_SANDBOXES } from '../../src/daytona-key'
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

describe('isPermissionDenied', () => {
  it('is Daytona`s 403 and nothing else', () => {
    expect(isPermissionDenied(new DaytonaForbiddenError('Access denied', 403))).toBe(true)
    // The status, not the class: an error that crossed a package boundary, or
    // came from an SDK that renamed the class, still carries the number.
    expect(isPermissionDenied(new DaytonaError('Access denied', 403))).toBe(true)
    expect(isPermissionDenied({ statusCode: 403 })).toBe(true)
    expect(isPermissionDenied(new DaytonaNotFoundError('gone', 404))).toBe(false)
    expect(isPermissionDenied(new Error('Access denied'))).toBe(false)
    expect(isPermissionDenied(undefined)).toBe(false)
  })
})

describe('sandboxBrakes says what Daytona does to the box on its own', () => {
  it('the provisioned defaults: stop after 30 idle minutes, delete 60 minutes later, destroy at the TTL', () => {
    expect(sandboxBrakes({ autoStopMinutes: 30, autoDeleteMinutes: 60, expiresAt: '2026-09-04T16:00:00.000Z' }))
      .toBe('stops after 30 idle minutes and is deleted 60 minutes after it stops, and is destroyed at ' +
        '2026-09-04T16:00:00.000Z whatever state it is in')
  })

  it('reads Daytona`s off values as off, rather than as "0 minutes"', () => {
    // autoStopInterval 0 disables auto-stop; autoDeleteInterval -1 (the
    // default) disables auto-delete and 0 deletes at once.
    expect(sandboxBrakes({ autoStopMinutes: 0, autoDeleteMinutes: -1 })).toBe('never stops on its own and is never auto-deleted')
    expect(sandboxBrakes({})).toBe('never stops on its own and is never auto-deleted')
    expect(sandboxBrakes({ autoStopMinutes: 15, autoDeleteMinutes: 0 })).toBe('stops after 15 idle minutes and is deleted as soon as it stops')
  })
})

describe('what teardown says when Daytona answers 403', () => {
  // Measured today: DELETE /api/sandbox/<id> with a key whose permissions are
  // ["write:sandboxes"] is a 403, which surfaced as `FAILED Access denied` and
  // exit 1 — a message that names neither the cause nor what the box does now.
  const refused = teardownRefusedMessage({
    sandboxId: 'dtn_1', twinId: 'sbx_1', ownsTwin: false,
    autoStopMinutes: 30, autoDeleteMinutes: 60, expiresAt: '2026-09-04T16:00:00.000Z',
    key: { name: 'veris-trial', permissions: ['write:sandboxes'] },
  })

  it('names the sandbox, the key, its permissions and the one it lacks', () => {
    expect(refused).toContain('refused to delete sandbox dtn_1')
    expect(refused).toContain('DAYTONA_API_KEY "veris-trial" (permissions: write:sandboxes)')
    expect(refused).toContain(`lacks the \`${DELETE_SANDBOXES}\` permission`)
  })

  it('says the box is still there and when Daytona will stop and delete it', () => {
    expect(refused).toContain('The sandbox is still there')
    expect(refused).toContain('stops after 30 idle minutes')
    expect(refused).toContain('is deleted 60 minutes after it stops')
    expect(refused).toContain('destroyed at 2026-09-04T16:00:00.000Z')
  })

  it('says what happened to the twin — an attached one was not touched', () => {
    expect(refused).toContain('Twin sbx_1 is yours and was not touched')
  })

  it('an owned twin was already deleted, because the wrapped delete drops the twin first', () => {
    const m = teardownRefusedMessage({ sandboxId: 'dtn_1', twinId: 'sbx_1', ownsTwin: true })
    expect(m).toContain('twin sbx_1 was deleted before Daytona refused')
  })

  it('says nothing about a twin when there is none', () => {
    expect(teardownRefusedMessage({ sandboxId: 'dtn_1', ownsTwin: false })).not.toMatch(/twin/i)
  })

  it('says how to fix it: a key with the permission, or the dashboard', () => {
    expect(refused).toContain('https://app.daytona.io/dashboard/keys')
    expect(refused).toContain('"delete sandboxes" permission')
    expect(refused).toContain('veris-daytona teardown dtn_1')
    expect(refused).toContain('Daytona dashboard')
  })

  it('still explains the 403 when the key`s own record could not be read, without claiming to have read it', () => {
    const m = teardownRefusedMessage({ sandboxId: 'dtn_1', ownsTwin: false, autoStopMinutes: 30, autoDeleteMinutes: 60 })
    expect(m).toContain('403 (Access denied)')
    expect(m).toContain(`without the \`${DELETE_SANDBOXES}\` permission`)
    expect(m).toContain('could not be read to confirm it')
    expect(m).not.toContain('permissions:')
  })
})
