/**
 * Copyright Veris AI
 * SPDX-License-Identifier: Apache-2.0
 *
 * Where the agent finds out which twin is its own.
 *
 * Every tool on the Veris MCP takes a `sandbox_id`, and the twin's id is not
 * something the agent can discover from inside the sandbox — it is held by the
 * session manager on the host, keyed by session. That mapping is the one thing
 * an MCP server cannot know, which is why this is a plugin tool and the
 * lifecycle operations are not.
 *
 * It is also the reachable way in to a service's manual, which is the document
 * Veris expects you to read before designing anything against a twin.
 */

import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import { isVerisSandbox } from '@veris-ai/daytona'
import type { DaytonaSessionManager } from '../core/session-manager'

export const verisTwinTool = (
  sessionManager: DaytonaSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    "Identify this session's Veris twin: its id, and the vendor services it answers for. " +
    'Call it before any Veris MCP tool, which all take a sandbox_id — this is where that id ' +
    'comes from, and creating a new Veris sandbox instead would give you one nothing else ' +
    "in the session is using. Pass a service name to read that service's manual: what the " +
    'twin models and how its data is shaped, which is worth reading before writing code ' +
    'against it.',
  args: {
    service: z
      .string()
      .optional()
      .describe("Service name (e.g. \"stripe\") to read its manual. Omit to list the twin's services."),
  },
  async execute(args: { service?: string }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)

    // Without this OpenCode renders the call as "verisTwin Unknown".
    const title = (t: string) => ctx.metadata({ title: t })

    if (!isVerisSandbox(sandbox)) {
      title('no twin attached')
      return (
        'No Veris twin is attached to this sandbox.\n' +
        'Set VERIS_API_KEY and VERIS_ENVIRONMENT_ID and start a new session to get one.'
      )
    }

    const twinId = sandbox.verisSandboxId

    if (args.service) {
      const manual = await sandbox.veris.manual(args.service)
      title(`${args.service} manual`)
      return `Manual for '${args.service}' (twin ${twinId}):\n\n${manual}`
    }

    const services = await sandbox.veris.services()
    title(`twin ${twinId} — ${services.length} service(s)`)

    if (services.length === 0) {
      return (
        `Veris twin ${twinId} answers for no services.\n\n` +
        'Its environment has none configured, so no vendor call from this sandbox will be ' +
        'intercepted. Check VERIS_ENVIRONMENT_ID.'
      )
    }

    const rows = services
      .map((s) => `  ${s.name} (${s.status}) -> ${s.url}`)
      .join('\n')

    return (
      `Veris twin ${twinId}\n\n` +
      `${services.length} service(s):\n${rows}\n\n` +
      'Pass a service name to this tool to read its manual. Use the twin id above as ' +
      "sandbox_id for Veris MCP tools; do not create a new Veris sandbox — this session's " +
      'twin is created and deleted for you.'
    )
  },
})
