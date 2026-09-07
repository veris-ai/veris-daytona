import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { DaytonaSessionManager } from '../core/session-manager'
import { isVerisSandbox } from '@veris-ai/daytona'
import { randomUUID } from 'node:crypto'
import type { ReceiptBaseline } from '@veris-ai/daytona'

export const verisReceiptTool = (sessionManager: DaytonaSessionManager, projectId: string, worktree: string, pluginCtx: PluginInput) => {
  // Opaque host-side handles prevent a model from editing ids to omit traffic.
  // Restart/eviction requires a fresh pre-execution baseline, never a fallback.
  const baselines = new Map<string, { sessionId: string; baseline: ReceiptBaseline }>()
  return {
    description: 'Capture action=baseline before an isolated application command; then action=read with its baseline token. No token reads cumulative history, not current-run evidence. Finish probes/seeding first. Other application/probe traffic in the window cannot be distinguished automatically.',
    args: {
      action: z.enum(['baseline', 'read']).optional(),
      baseline: z.string().optional().describe('Opaque token returned by action=baseline in this session.'),
      service: z.string().optional(),
    },
    async execute(args: { action?: 'baseline' | 'read'; baseline?: string; service?: string }, ctx: ToolContext) {
      const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
      if (!isVerisSandbox(sandbox)) throw new Error('No Veris twin is attached to this sandbox')
      const identity = { provider: 'daytona', sessionId: ctx.sessionID, sandboxId: sandbox.id, twinId: sandbox.verisSandboxId }
      if (args.action === 'baseline') {
        if (args.baseline || args.service) throw new Error('Capture a baseline for all services without a baseline token or service filter')
        const baseline = await sandbox.veris.receiptBaseline()
        const token = randomUUID()
        if (baselines.size >= 100) baselines.delete(baselines.keys().next().value!)
        baselines.set(token, { sessionId: ctx.sessionID, baseline })
        ctx.metadata({ title: 'receipt baseline captured' })
        return JSON.stringify({ ...identity, baseline: token, watermarks: Object.fromEntries(Object.entries(baseline.services).map(([name, mark]) => [name, mark.id])),
          instruction: 'Now run the isolated application command, await completion, then read this baseline. Do not seed, probe, reset or replace the session in between.' })
      }
      const selected = args.baseline ? baselines.get(args.baseline) : undefined
      if (args.baseline && (!selected || selected.sessionId !== ctx.sessionID)) throw new Error('Unknown or expired baseline for this session; capture a new baseline before execution')
      const receipt = selected ? await sandbox.veris.receiptSince(selected.baseline, args.service) : await sandbox.veris.receipt()
      if (args.service && !receipt.services[args.service]) throw new Error(`Unknown HTTP service '${args.service}'`)
      const services = Object.fromEntries(Object.entries(receipt.services)
        .filter(([name]) => !args.service || name === args.service)
        .map(([name, entry]) => {
          const e = entry!
          return [name, { requests: e.requests, countKind: e.capped ? 'at-least' : 'exact', complete: !e.capped,
            incompleteReason: e.incompleteReason, sinceId: e.sinceId, untilId: e.untilId, entries: e.entries.slice(0, 50),
            omittedEntries: Math.max(0, e.entries.length - 50) }]
        }))
      const complete = Object.values(services).every(e => e.complete)
      const count = Object.values(services).reduce((total, e) => total + e.requests, 0)
      ctx.metadata({ title: `${complete ? '' : 'at least '}${count} observed request(s)` })
      return JSON.stringify({ ...identity, scope: selected ? 'since-baseline' : 'cumulative', baseline: args.baseline,
        mode: receipt.mode, integrity: receipt.integrity, leaks: receipt.leaks, complete, serviceCount: Object.keys(services).length, services,
        note: 'Entries are trace observations, not proof of all application egress or completed state changes. Excludes control and explicitly marked probe tiers. Unmarked vendor probes/concurrent runs cannot be attributed; isolate execution. Use verisControl requests for raw bodies and paginate; omittedEntries is display truncation.' })
    },
  }
}
