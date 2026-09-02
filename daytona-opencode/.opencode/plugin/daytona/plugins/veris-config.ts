/**
 * Copyright Veris AI
 * SPDX-License-Identifier: Apache-2.0
 *
 * Wires the Veris MCP server into the session, and gates the two of its tools
 * that are always wrong here.
 *
 * The MCP is the shared home for twin LIFECYCLE (get, promote, reset). Keeping
 * it there rather than reimplementing those as plugin tools is what stops a
 * second engine plugin from having to grow the same surface again: the only
 * thing to copy is this file.
 *
 * Everything is `??=`, so a user's own opencode.json always wins and someone who
 * already has `@veris-ai/veris-sim-opencode` installed globally gets no double
 * registration. The whole body is wrapped: a failed registration should surface
 * as a missing MCP server, never as OpenCode failing to start.
 */

import type { Hooks } from '@opencode-ai/plugin'
import { logger } from '../core/logger'

type OpencodeConfig = Parameters<NonNullable<Hooks['config']>>[0]

/**
 * Defaults for the MCP's destructive tools. The plugin creates and owns this
 * session's twin, which is what makes two of these never the right call:
 *
 *   create_sandbox   makes a twin the plugin does not know about. Traffic still
 *                    goes to the plugin's twin and verisReceipt still reads the
 *                    plugin's twin, so the agent would seed the orphan and then
 *                    report success — the exact failure the receipt exists to
 *                    catch, reintroduced one layer up.
 *   delete_sandbox   destroys the running session's twin. The egress credential
 *                    dies with it and every later call fails obscurely.
 *   promote_sandbox  legitimate, but it freezes and scrubs the sandbox AND
 *                    rewrites what every future run in the environment starts
 *                    from. That is a human's decision.
 *   reset_sandbox    legitimate, but it clears /veris/requests, which is the
 *                    receipt.
 */
const TOOL_PERMISSIONS: Record<string, 'ask' | 'deny'> = {
  veris_create_sandbox: 'deny',
  veris_delete_sandbox: 'deny',
  veris_promote_sandbox: 'ask',
  veris_reset_sandbox: 'ask',
}

const DEFAULT_API_BASE = 'https://svc.api.veris.ai'

export async function verisConfig(cfg: OpencodeConfig): Promise<void> {
  try {
    // No key, no registration. Registering with an empty header instead would
    // give a server that fails every call and reads as a Veris outage; the
    // session manager already reports the missing credential properly.
    const apiKey = process.env.VERIS_API_KEY
    if (!apiKey) return

    cfg.mcp ??= {}
    cfg.mcp.veris ??= {
      type: 'remote',
      url: `${process.env.VERIS_API_BASE || DEFAULT_API_BASE}/mcp`,
      headers: { 'X-API-Key': apiKey },
      // The Veris MCP authenticates by header. Without this, OAuth
      // auto-detection can intercept the connection and prompt for a login
      // that does not exist.
      oauth: false,
    }

    // `permission` may legally be a bare 'ask' | 'allow' | 'deny' that applies
    // to everything; only the object form takes per-tool keys. The bundled SDK
    // types predate both that string form and the arbitrary-tool-name index
    // signature the running config schema documents, hence the assertion.
    if (typeof cfg.permission === 'string') return
    const permission = (cfg.permission ??= {}) as Record<string, unknown>
    for (const [tool, action] of Object.entries(TOOL_PERMISSIONS)) {
      permission[tool] ??= action
    }
  } catch (err) {
    logger.warn(`[veris] MCP registration skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
}
