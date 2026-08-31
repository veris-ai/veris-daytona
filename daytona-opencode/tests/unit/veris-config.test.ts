import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { verisConfig } from '../../.opencode/plugin/daytona/plugins/veris-config'

// The hook takes opencode's Config; these tests only ever touch `mcp` and
// `permission`, so a loose shape keeps them readable.
type Cfg = Parameters<typeof verisConfig>[0]
const cfg = (over: Record<string, unknown> = {}) => over as unknown as Cfg

const ENV = { ...process.env }
beforeEach(() => {
  process.env.VERIS_API_KEY = 'vsk_test'
  delete process.env.VERIS_API_BASE
})
afterEach(() => { process.env = { ...ENV } })

describe('MCP registration', () => {
  it('registers the Veris MCP against the default control plane', async () => {
    const c = cfg()
    await verisConfig(c)
    expect((c as any).mcp.veris).toEqual({
      type: 'remote',
      url: 'https://svc.api.veris.ai/mcp',
      headers: { 'X-API-Key': 'vsk_test' },
      oauth: false,
    })
  })

  it('honours VERIS_API_BASE', async () => {
    process.env.VERIS_API_BASE = 'https://svc.dev.api.veris.ai'
    const c = cfg()
    await verisConfig(c)
    expect((c as any).mcp.veris.url).toBe('https://svc.dev.api.veris.ai/mcp')
  })

  // Registering with an empty key gives a server that fails every call, which
  // reads as a Veris outage rather than a missing setting.
  it('registers nothing without an API key', async () => {
    delete process.env.VERIS_API_KEY
    const c = cfg()
    await verisConfig(c)
    expect((c as any).mcp).toBeUndefined()
    expect((c as any).permission).toBeUndefined()
  })

  it('never clobbers a user-configured veris server', async () => {
    const mine = { type: 'remote', url: 'https://mine/mcp' }
    const c = cfg({ mcp: { veris: mine } })
    await verisConfig(c)
    expect((c as any).mcp.veris).toBe(mine)
  })

  it('leaves other MCP servers alone', async () => {
    const c = cfg({ mcp: { other: { type: 'remote', url: 'https://other/mcp' } } })
    await verisConfig(c)
    expect(Object.keys((c as any).mcp).sort()).toEqual(['other', 'veris'])
  })
})

describe('permission defaults', () => {
  it('denies the two calls that are always wrong when the plugin owns the twin', async () => {
    const c = cfg()
    await verisConfig(c)
    expect((c as any).permission).toMatchObject({
      veris_create_sandbox: 'deny',
      veris_delete_sandbox: 'deny',
      veris_promote_sandbox: 'ask',
      veris_reset_sandbox: 'ask',
    })
  })

  it('never overrides a permission the user set', async () => {
    const c = cfg({ permission: { veris_promote_sandbox: 'allow', edit: 'ask' } })
    await verisConfig(c)
    expect((c as any).permission.veris_promote_sandbox).toBe('allow')
    expect((c as any).permission.edit).toBe('ask')
    expect((c as any).permission.veris_create_sandbox).toBe('deny')
  })

  // `permission` may be a bare 'allow' | 'ask' | 'deny' applying to everything.
  // Assigning keys onto a string would throw in strict mode and silently no-op
  // otherwise; either way it must not take the hook down.
  it('leaves a blanket string permission untouched', async () => {
    const c = cfg({ permission: 'allow' })
    await expect(verisConfig(c)).resolves.toBeUndefined()
    expect((c as any).permission).toBe('allow')
    expect((c as any).mcp.veris).toBeDefined()
  })
})
