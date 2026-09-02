/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PluginInput } from '@opencode-ai/plugin'
import type { ExperimentalChatSystemTransformInput, ExperimentalChatSystemTransformOutput } from '../core/types'

/**
 * Adds Daytona-specific instructions to the system prompt.
 */
export async function systemPromptTransform(ctx: PluginInput, repoPath: string) {
  return async (input: ExperimentalChatSystemTransformInput, output: ExperimentalChatSystemTransformOutput) => {
    output.system.push(
      [
        '## Daytona Sandbox Integration',
        'This session is integrated with a Daytona sandbox.',
        `The main project repository is located at: ${repoPath}.`,
        'Bash commands will run in this directory.',
        'Put all projects in the project directory. Do NOT try to use the current working directory of the host system.',
        "When executing long-running commands, use the 'background' option to run them asynchronously.",
        'Before showing a preview URL, ensure the server is running in the sandbox on that port.',
        'When the user asks to sync, hand off, or finalize changes, run the gitSync tool and report its result.',
        '',
        '## Veris Twin',
        "This sandbox's outbound calls to external vendor APIs are answered by a Veris twin:",
        'a stateful fake that speaks the real protocol at the real hostname. Code under test',
        'is unmodified — production hostnames, production credentials, production client',
        'libraries — and nothing you run here reaches the real vendor. Hosts the twin does',
        'not answer for are BLOCKED, not silently forwarded, so a connection error to an',
        'external API is information: that dependency is not part of this environment.',
        '',
        'A passing run proves nothing on its own. A test suite that skipped its integration',
        'and a test suite that exercised it look identical from inside the sandbox, and so',
        'does a call you believe you made but did not. Only the receipt distinguishes them.',
        'So: after any change meant to reach an external API, run the verisReceipt tool and',
        'read what the twin actually received. If the receipt is empty, the change does not',
        'work yet — report that, do not report success. Cite the receipt when you claim an',
        'integration works.',
        '',
        'The twin already exists and this plugin owns its lifecycle: it was created with the',
        'sandbox and is deleted with it. Do NOT create or delete Veris sandboxes. Run the',
        'verisTwin tool to get its id (every Veris MCP tool takes one) and to read a',
        "service's manual before writing code against it. Nothing here runs under",
        '`veris-proxy` — egress is already intercepted at the sandbox boundary, so any',
        'instruction to start a proxy or provision a sandbox is describing a different setup',
        'than this one.',
        '',
        'TLS trust is already configured. The CA variables point at files that carry the',
        'gateway CA, and `NODE_OPTIONS` carries `--use-openssl-ca` so Node reads the system',
        'store, which has it too (Daytona points `NODE_EXTRA_CA_CERTS` at its own file;',
        'expected, not a problem to fix). Plain `node`, `curl`, `python`, `pip` and `npm`',
        'verify vendor hosts as-is. Do NOT prefix commands with',
        '`NODE_EXTRA_CA_CERTS=...`, pass `--cacert`, or set `NODE_TLS_REJECT_UNAUTHORIZED=0`.',
        'An HTTPS failure with the defaults is a finding to report, not something to paper',
        'over per command.',
      ].join('\n'),
    )
  }
}
