/**
 * Copyright Veris AI
 * SPDX-License-Identifier: Apache-2.0
 *
 * The eleventh tool, and the only one this fork adds.
 *
 * Every other tool tells the agent what its own code did. This one tells it
 * what the VENDOR received — read from the twin, not from the sandbox — which
 * is the only way to tell a real integration from a plausible-looking one. An
 * agent that says "I called the Stripe API and it worked" and an agent that
 * fabricated the response produce identical transcripts; they produce different
 * receipts.
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
    'Read the Veris receipt: what the vendor twin ACTUALLY received from this sandbox. ' +
    'Use it after any change that is supposed to reach an external API, and before ' +
    'reporting that the change works. A green run with an empty receipt means the code ' +
    'never reached the dependency — the two are indistinguishable from inside the sandbox. ' +
    'Pass a service name to see that service alone.',
  args: {
    service: z
      .string()
      .optional()
      .describe('Service name (e.g. "stripe"). Omit for every service on the twin.'),
  },
  async execute(args: { service?: string }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)

    if (!isVerisSandbox(sandbox)) {
      return (
        'No Veris twin is attached to this sandbox, so there is no receipt to read.\n' +
        'Set VERIS_API_KEY and VERIS_ENVIRONMENT_ID and start a new session to get one.'
      )
    }

    if (args.service) {
      const entry = await sandbox.veris.receipt(args.service)
      if (entry.requests === 0) {
        return (
          `Receipt for '${args.service}': ZERO requests.\n\n` +
          `The twin was reachable and answered nothing — the code under test never called it. ` +
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

    const header =
      `Veris receipt — twin ${sandbox.verisSandboxId}\n` +
      `  interception: ${receipt.mode}   integrity: ${receipt.integrity}\n` +
      (receipt.leaks.length ? `  blind spots: ${receipt.leaks.join(', ')}\n` : '')

    if (total === 0) {
      return (
        header +
        `\nZERO requests reached the twin, across ${names.length || 'no'} service(s).\n\n` +
        `Whatever just ran did not touch its external dependencies. If you were asked to ` +
        `make an integration work, it does not work yet — say so rather than reporting success.`
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
