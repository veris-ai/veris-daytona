/**
 * Copyright Veris AI
 * SPDX-License-Identifier: Apache-2.0
 *
 * The tool this fork exists for.
 *
 * Reads a bounded view of the twin log, including earlier and control traffic.
 * Attribution needs a baseline, new application entries and response/state
 * assertions; a nonzero cumulative count cannot prove the current run.
 */

import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import { isVerisSandbox } from '@veris-ai/daytona'
import type { DaytonaSessionManager } from '../core/session-manager'

export const verisReceiptTool = (
  sessionManager: DaytonaSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Read a bounded Veris twin request log, including earlier work and control traffic. ' +
    'Capture a baseline before the application flow and compare afterward on the same twin. ' +
    'A nonzero total alone does not prove this run; keep response/state assertions. ' +
    'The full view shows up to 20 entries per HTTP service; a service view shows up to 50 ' +
    'and omits the twin id. Pass a service name to see that service alone.',
  args: {
    service: z
      .string()
      .optional()
      .describe('Service name (e.g. "stripe"). Omit for every service on the twin.'),
  },
  async execute(args: { service?: string }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)

    // Without this OpenCode renders the call as "verisReceipt Unknown".
    const title = (t: string) => ctx.metadata({ title: t })

    if (!isVerisSandbox(sandbox)) {
      title('no twin attached')
      return (
        'No Veris twin is attached to this sandbox, so there is no receipt to read.\n' +
        'Set VERIS_API_KEY and VERIS_ENVIRONMENT_ID and start a new session to get one.'
      )
    }

    if (args.service) {
      const entry = await sandbox.veris.receipt(args.service)
      title(`${args.service}: ${entry.requests} request(s)`)
      if (entry.requests === 0) {
        return (
          `Receipt for '${args.service}': ZERO requests.\n\n` +
          `No requests appear in this returned service log; arrival for the current run is unproven. ` +
          `Do not report this change as working.`
        )
      }
      const lines = entry.entries
        .slice(0, 50)
        .map((r) => `  ${r.method} ${r.path} -> ${r.status ?? 'no response (fault)'}`)
      return (
        `Receipt for '${args.service}': ${entry.requests} request(s).\n` +
        `${lines.join('\n')}${entry.entries.length > 50 ? `\n  … ${entry.entries.length - 50} more` : ''}`
      )
    }

    const receipt = await sandbox.veris.receipt()
    const names = Object.keys(receipt.services)
    const total = names.reduce((n, k) => n + (receipt.services[k]?.requests ?? 0), 0)
    title(`${total} request(s) across ${names.length} service(s)`)

    const header =
      `Veris receipt — twin ${sandbox.verisSandboxId}\n` +
      `  interception: ${receipt.mode}   integrity: ${receipt.integrity}\n` +
      (receipt.leaks.length ? `  blind spots: ${receipt.leaks.join(', ')}\n` : '')

    if (total === 0) {
      return (
        header +
        `\nZERO requests reached the twin, across ${names.length || 'no'} service(s).\n\n` +
        `No requests appear in these returned logs; arrival for the current run is unproven. ` +
        `Report that limitation rather than claiming the integration was verified.`
      )
    }

    const body = names
      .map((name) => {
        const e = receipt.services[name]!
        const calls = e.entries
          .slice(0, 20)
          .map((r) => `    ${r.method} ${r.path} -> ${r.status ?? 'no response (fault)'}`)
        return `  ${name}: ${e.requests} request(s)\n${calls.join('\n')}`
      })
      .join('\n')

    return `${header}\n${total} request(s) reached the twin:\n${body}`
  },
})
