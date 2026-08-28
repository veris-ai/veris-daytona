/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod'
import { DaytonaNotFoundError } from '@daytona/sdk'
import { isVerisSandbox } from '@veris-ai/daytona'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { DaytonaSessionManager } from '../core/session-manager'

export const bashTool = (
  sessionManager: DaytonaSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
  repoPath: string,
) => ({
  description: 'Executes shell commands in a Daytona sandbox',
  args: {
    command: z.string(),
    background: z.boolean().optional(),
  },
  async execute(args: { command: string; background?: boolean }, ctx: ToolContext) {
    const sessionId = ctx.sessionID
    const sandbox = await sessionManager.getSandbox(sessionId, projectId, worktree, pluginCtx)

    if (args.background) {
      const execSessionId = `exec-session-${sessionId}`
      try {
        await sandbox.process.getSession(execSessionId)
      } catch (err) {
        if (!(err instanceof DaytonaNotFoundError)) {
          throw err
        }
        await sandbox.process.createSession(execSessionId)
      }
      await sandbox.process.executeSessionCommand(execSessionId, {
        command: `cd ${repoPath}`,
      })
      // Background commands run in a persistent shell session, which takes no
      // env argument — so the interception environment is exported into the
      // session once, before anything runs in it.
      if (isVerisSandbox(sandbox)) {
        const exports = Object.entries(await sandbox.veris.env())
          .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
          .join('; ')
        if (exports) await sandbox.process.executeSessionCommand(execSessionId, { command: exports })
      }
      const result = await sandbox.process.executeSessionCommand(execSessionId, {
        command: args.command,
        runAsync: true,
      })
      return `Command started in background (cmdId: ${result.cmdId})`
    } else {
      // Pass the Veris interception environment, or the agent's vendor calls
      // never reach the twin.
      //
      // Daytona injects its own HTTP(S)_PROXY into every sandbox, aimed at its
      // internal netleash MITM, and that beats create-time envVars, image ENV
      // and /etc/profile.d alike (executeCommand does not read profile at all).
      // Left alone, netleash answers 403 for any vendor host — the call fails
      // instead of being intercepted. This is the one place the agent's own
      // commands are launched, so it is the one place that has to say so.
      const verisEnv = isVerisSandbox(sandbox) ? await sandbox.veris.env() : undefined
      const result = await sandbox.process.executeCommand(args.command, repoPath, verisEnv)
      return `Exit code: ${result.exitCode}\n${result.result}`
    }
  },
})
