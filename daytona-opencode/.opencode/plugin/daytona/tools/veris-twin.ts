import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { DaytonaSessionManager } from '../core/session-manager'
import { isVerisSandbox } from '@veris-ai/daytona'

export const verisTwinTool = (sessionManager: DaytonaSessionManager, projectId: string, worktree: string, pluginCtx: PluginInput) => ({
  description: 'Discover the existing plugin-owned session, twin services and available tool interfaces. Pass service to read its manual. Reuse this session; the plugin provisions and tears down resources.',
  args: { service: z.string().optional() },
  async execute(args: { service?: string }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    if (!isVerisSandbox(sandbox)) throw new Error('No Veris twin is attached to this sandbox')
    const identity = { provider: 'daytona', sessionId: ctx.sessionID, sandboxId: sandbox.id, twinId: sandbox.verisSandboxId, environmentId: sandbox.veris.environmentId,
      workingDirectory: sessionManager.repoPath, lifecycleOwner: 'plugin',
      twinOwnership: sandbox.veris.ownsTwin ? 'plugin' : 'external' }
    ctx.metadata({ title: `twin ${sandbox.verisSandboxId}` })
    if (args.service) return JSON.stringify({ ...identity, service: args.service, manual: await sandbox.veris.manual(args.service) })
    const services = await sandbox.veris.services()
    return JSON.stringify({ ...identity, services: services.map(s => ({ name: s.name, status: s.status,
      routes: s.routes, controlUrl: s.control_url, envHint: s.env_hint })),
      capabilities: { receipt: { tool: 'verisReceipt', baseline: true, raw: 'verisControl requests' },
        control: { tool: 'verisControl', resources: ['manual', 'schema', 'operations', 'data', 'requests'],
          writes: 'POST/PATCH data: schema-defined seed and fault tables; permission verisControlWrite',
          limitation: 'Service support must be checked via schema/manual. File-byte transfer and lifecycle mutations are not provided by this tool.' },
        files: ['read', 'write', 'edit', 'multiedit', 'ls', 'glob', 'grep'], execution: 'bash', synchronization: 'gitSync' },
      instruction: 'Verify the remote source with pwd and git rev-parse HEAD. Use verisSkill for installed skill files; application file tools are remote. Do not create, reset or tear down this twin from a skill.' })
  },
})
