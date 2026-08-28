import { describe, expect, it } from 'vitest'
import * as sdk from '@daytona/sdk'
import * as veris from '../../src/index'
import { Daytona as VerisDaytona } from '../../src/daytona'

describe('the drop-in surface', () => {
  it('overrides Daytona with ours', () => {
    // The whole trick that makes the plugin fork a one-line diff: an explicit
    // local export beats the star re-export.
    expect(veris.Daytona).toBe(VerisDaytona)
    expect(veris.Daytona).not.toBe(sdk.Daytona)
  })

  it('is still a Daytona, so the plugin`s `new Daytona({apiKey})` keeps working', () => {
    expect(Object.getPrototypeOf(VerisDaytona)).toBe(sdk.Daytona)
    expect(VerisDaytona.prototype).toBeInstanceOf(sdk.Daytona)
  })

  it('re-exports everything the plugin imports from @daytona/sdk', () => {
    // session-manager.ts:17 and tools/* import exactly these.
    for (const name of [
      'Sandbox', 'DaytonaNotFoundError', 'DaytonaValidationError', 'Image', 'SandboxState',
    ]) {
      expect(veris, `missing re-export: ${name}`).toHaveProperty(name)
    }
  })
})

describe('error identity across the package boundary', () => {
  // The plugin does `err instanceof DaytonaNotFoundError` to tell "the sandbox
  // is gone, replace it" from "transient failure, keep the session mapping".
  // tools/bash.ts imports that class from '@daytona/sdk' DIRECTLY while
  // session-manager imports from us, so if npm ever resolves two copies of the
  // SDK those checks silently return false and sessions lose their sandbox
  // binding. @daytona/sdk being a peerDependency is what prevents it; this is
  // the test that fails loudly if that ever regresses.
  it.each([
    'DaytonaNotFoundError',
    'DaytonaValidationError',
    'DaytonaConflictError',
    'DaytonaError',
  ])('%s is the SAME class object as @daytona/sdk exports', (name) => {
    expect((veris as Record<string, unknown>)[name]).toBe((sdk as Record<string, unknown>)[name])
  })

  it('an SDK error still satisfies instanceof through our re-export', () => {
    const err = new sdk.DaytonaNotFoundError('gone')
    expect(err).toBeInstanceOf(veris.DaytonaNotFoundError)
  })
})
