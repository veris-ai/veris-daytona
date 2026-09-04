// `veris-daytona teardown <daytona-sandbox-id>`: delete a sandbox `provision`
// (or `run --keep`) left behind.
//
//   veris-daytona teardown 7f3c1e0a-…
//
// The twin is a separate question, and the answer is written on the sandbox:
// a twin this package created goes with it, a twin it merely attached to is
// the caller's and is left running. That is the same rule `sandbox.delete()`
// has always followed — see verisOwnsTwin in daytona.ts — so teardown reads it
// rather than restating it.
//
// Parsing is pure, so it is unit tested without a Daytona account. Everything
// that touches the network is in cli.ts.
import { UsageError } from './run'

export interface TeardownOptions {
  /** The Daytona sandbox id. Not the twin's. */
  sandboxId: string
}

export const TEARDOWN_USAGE = `usage: veris-daytona teardown <daytona-sandbox-id>

Deletes the Daytona sandbox. The id is the one \`veris-daytona provision\`
printed as daytonaSandboxId — not the Veris twin's id.

The twin follows the rule it was created under: one this package created is
deleted with the sandbox, one it attached to (\`provision\`, or \`run --sandbox\`)
is yours and is left running. Which of the two happened is printed.

needs: DAYTONA_API_KEY, and VERIS_API_KEY to reach a twin that must be deleted.

exit code: 0 when the sandbox is deleted; 1 when there is no such sandbox.`

/** Parse everything after `teardown`. Pure; throws UsageError with a human message. */
export function parseTeardownArgs(argv: readonly string[]): TeardownOptions {
  const ids: string[] = []
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') throw new UsageError(TEARDOWN_USAGE)
    if (arg.startsWith('-')) throw new UsageError(`unknown option '${arg}'\n\n${TEARDOWN_USAGE}`)
    ids.push(arg)
  }
  if (ids.length === 0) throw new UsageError(`no sandbox id given\n\n${TEARDOWN_USAGE}`)
  // One at a time, on purpose: the message says which twin was and was not
  // touched, and that sentence is only true of a single sandbox.
  if (ids.length > 1) {
    throw new UsageError(`teardown takes one sandbox id, got ${ids.length}: ${ids.join(' ')}`)
  }
  return { sandboxId: ids[0]! }
}
