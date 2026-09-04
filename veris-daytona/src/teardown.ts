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
// Parsing and the refusal message are pure, so they are unit tested without a
// Daytona account. Everything that touches the network is in cli.ts.
import { UsageError } from './run'
import { DELETE_PERMISSION_FIX, DELETE_SANDBOXES, describeKey } from './daytona-key'
import type { DaytonaKeyInfo } from './daytona-key'

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

needs: DAYTONA_API_KEY with the ${DELETE_SANDBOXES} permission — a key made with
"write sandboxes" alone is refused, and the refusal says when Daytona will stop
and delete the box on its own. To reach a twin that must be deleted, a Veris
key too: VERIS_API_KEY, or the profile \`veris login\` saved.

exit code: 0 when the sandbox is deleted; 1 when there is no such sandbox, or
the key may not delete one.`

/** The facts a refused delete is described from. Intervals are the sandbox's own. */
export interface RefusedTeardown {
  /** The Daytona sandbox id. */
  sandboxId: string
  twinId?: string
  /** Whether the wrapped delete removed the twin before Daytona refused the
   *  sandbox — it deletes the twin first, so an owned twin is already gone. */
  ownsTwin: boolean
  /** Daytona's `autoStopInterval`: idle minutes before it stops. 0 is off. */
  autoStopMinutes?: number
  /** Daytona's `autoDeleteInterval`: minutes after stopping before it is
   *  deleted. 0 is at once; negative or unset is never. */
  autoDeleteMinutes?: number
  /** Daytona's `autoDestroyAt`, when a TTL was set. */
  expiresAt?: string
  /** The key's record, when GET /api/api-keys/current answered. */
  key?: DaytonaKeyInfo
}

/**
 * Was this Daytona's "you may not" — HTTP 403 — rather than any other failure?
 * Read off the status the SDK stamps rather than a class, so the check holds
 * across the SDK's own renamings (DaytonaAuthorizationError became
 * DaytonaForbiddenError) and for an error that crossed a package boundary.
 */
export function isPermissionDenied(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { statusCode?: unknown }).statusCode === 403
}

/**
 * What Daytona will do to the box on its own, in one clause: "stops after 30
 * idle minutes and is deleted 60 minutes after it stops, and is destroyed at
 * <time> whatever state it is in". This is the substance of a refusal — the
 * reader's real question is whether the box bills forever, and the answer is
 * on the sandbox object.
 */
export function sandboxBrakes(r: Pick<RefusedTeardown, 'autoStopMinutes' | 'autoDeleteMinutes' | 'expiresAt'>): string {
  const stop = r.autoStopMinutes && r.autoStopMinutes > 0
    ? `stops after ${r.autoStopMinutes} idle minutes`
    : 'never stops on its own'
  const del = r.autoDeleteMinutes === undefined || r.autoDeleteMinutes < 0
    ? 'is never auto-deleted'
    : r.autoDeleteMinutes === 0
      ? 'is deleted as soon as it stops'
      : `is deleted ${r.autoDeleteMinutes} minutes after it stops`
  const destroy = r.expiresAt ? `, and is destroyed at ${r.expiresAt} whatever state it is in` : ''
  return `${stop} and ${del}${destroy}`
}

/**
 * What `teardown` says when Daytona answered 403.
 *
 * The bare "FAILED Access denied" this replaces named neither the cause nor the
 * consequence. The cause is a key without `delete:sandboxes` — the one
 * permission DELETE /api/sandbox/<id> checks, and one a key made with "write
 * sandboxes" alone does not have. The consequence is a box that is still there
 * and still billing, so the message says exactly when Daytona will stop and
 * delete it by itself, what happened to the twin, and how to delete it sooner.
 */
export function teardownRefusedMessage(r: RefusedTeardown): string {
  const key = r.key
    ? `this DAYTONA_API_KEY ${describeKey(r.key)} lacks the \`${DELETE_SANDBOXES}\` permission`
    : `Daytona answered 403 (Access denied), which is what a DAYTONA_API_KEY without the ` +
      `\`${DELETE_SANDBOXES}\` permission gets — the key's own record could not be read to confirm it`
  const twin = r.twinId === undefined
    ? ''
    : r.ownsTwin
      ? ` Its twin ${r.twinId} was deleted before Daytona refused, so nothing is left on the Veris side.`
      : ` Twin ${r.twinId} is yours and was not touched.`
  return (
    `Daytona refused to delete sandbox ${r.sandboxId}: ${key}. ` +
    `The sandbox is still there: it ${sandboxBrakes(r)}.${twin} ` +
    `To delete it sooner, ${DELETE_PERMISSION_FIX}, then run \`veris-daytona teardown ${r.sandboxId}\` ` +
    `with it — or delete the sandbox in the Daytona dashboard.`
  )
}

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
