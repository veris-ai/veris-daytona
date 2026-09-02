import { describe, it, expect } from 'vitest'
import { systemPromptTransform } from '../../.opencode/plugin/daytona/plugins/system-transform'

// The hook only reads the repo path; a bare object stands in for OpenCode's
// plugin input.
const ctx = {} as unknown as Parameters<typeof systemPromptTransform>[0]

async function render(): Promise<string> {
  const hook = await systemPromptTransform(ctx, '/workspace/repo')
  const output = { system: [] as string[] }
  await hook({ model: {} }, output)
  return output.system.join('\n')
}

describe('system prompt', () => {
  it('tells the agent TLS trust is preconfigured, so it stops prefixing every command', async () => {
    // Regression for agents that learned, on 0.2.0 sandboxes, to prepend
    // NODE_EXTRA_CA_CERTS=/tmp/veris-ca-bundle.crt to every node invocation.
    // The variables are set at create time now; the prompt has to say so, or
    // the agent sees a bundle file plus a dozen CA vars and hedges anyway.
    const s = await render()
    expect(s).toContain('TLS trust is already configured')
    expect(s).toContain('NODE_EXTRA_CA_CERTS')
    expect(s).toMatch(/Do NOT prefix\s+commands/)
    expect(s).toContain('NODE_TLS_REJECT_UNAUTHORIZED=0')
  })

  it('still carries the Daytona and twin sections', async () => {
    const s = await render()
    expect(s).toContain('## Daytona Sandbox Integration')
    expect(s).toContain('/workspace/repo')
    expect(s).toContain('## Veris Twin')
  })
})
