import { describe, it, expect } from 'vitest'
import { VerisError } from '../../src/errors'

describe('VerisError folds the cause into its message', () => {
  // The regression this exists for: "Daytona sandbox create failed" was the
  // whole message a user saw for an invalid API key, because nothing that
  // renders an error walks the cause chain.
  it('appends an Error cause', () => {
    const e = new VerisError('Daytona sandbox create failed', {
      cause: new Error('Invalid credentials'),
    })
    expect(e.message).toBe('Daytona sandbox create failed: Invalid credentials')
  })

  it('keeps the cause reachable as well', () => {
    const cause = new Error('Invalid credentials')
    expect(new VerisError('x', { cause }).cause).toBe(cause)
  })

  it('appends a string cause', () => {
    expect(new VerisError('failed', { cause: 'nope' }).message).toBe('failed: nope')
  })

  it('says nothing extra when there is no cause', () => {
    expect(new VerisError('failed').message).toBe('failed')
    expect(new VerisError('failed', { phase: 'canary' }).message).toBe('failed')
  })

  it('does not repeat a detail the message already carries', () => {
    const e = new VerisError('create failed: Invalid credentials', {
      cause: new Error('Invalid credentials'),
    })
    expect(e.message).toBe('create failed: Invalid credentials')
  })

  it('truncates a runaway cause rather than pasting a whole response body', () => {
    const e = new VerisError('failed', { cause: new Error('x'.repeat(500)) })
    expect(e.message.length).toBeLessThan(260)
    expect(e.message.endsWith('…')).toBe(true)
  })

  it('leaves phase and verisSandboxId intact', () => {
    const e = new VerisError('failed', {
      phase: 'sandbox-create', verisSandboxId: 'sbx_1', cause: new Error('why'),
    })
    expect(e.phase).toBe('sandbox-create')
    expect(e.verisSandboxId).toBe('sbx_1')
    expect(e.message).toBe('failed: why')
  })
})
