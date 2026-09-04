// `veris-daytona provision`: create a wired Daytona sandbox attached to a twin
// that already exists, print one JSON object describing it, and stop.
//
//   veris-daytona provision --sandbox sbx_a1b2c3 --image python:3.12
//
// It is `run` with the second half removed. Everything Veris-shaped still
// happens — the egress credential, the allowlist and its 20-domain fit, the
// sandbox with its outbound proxy, the CA bundle, the canary, the trust
// variables — and then it stops, with the box up and nothing running in it.
//
// The half it drops belongs somewhere else. Uploading code, installing it,
// running a suite, reading a receipt and deciding whether the run proved
// anything are the `veris` CLI's job, and it already owns what a receipt means,
// what --require-service means and what the exit codes mean. A second
// implementation of that here is how this one drifted.
//
// Argument parsing and the JSON shape are pure, so they are unit tested without
// a Daytona account. Everything that touches the network is in cli.ts.
import { UsageError } from './run'
import { BUNDLED_CA_PATCH_SCRIPT, VERIS_BUNDLE, trustPrelude } from './trust'

export interface ProvisionOptions {
  /** The twin to attach to. Required: a provisioned box is only useful pointed
   *  at a twin the caller already made. */
  sandbox: string
  /** Daytona image or snapshot to create the sandbox from. Unset: Daytona's default. */
  image?: string
  snapshot?: string
  /** Extra hostnames the sandbox may reach. */
  allowOut: string[]
  /** KEY=VALUE pairs set as sandbox environment variables. */
  env: Record<string, string>
}

/**
 * Idle minutes before Daytona stops the sandbox.
 *
 * Nothing deletes a provisioned box for the caller, so these two intervals are
 * the only thing standing between an abandoned box and a bill. Daytona's own
 * default is 15 minutes of no API activity; 30 is deliberately more generous,
 * because a caller here is installing dependencies and running a suite between
 * our calls and a box stopped underneath them is worse than half an hour of
 * idle compute.
 */
export const AUTO_STOP_MINUTES = 30

/**
 * Minutes after the sandbox stops before Daytona deletes it.
 *
 * Daytona disables auto-delete by default, so a stopped box keeps its disk (and
 * its cost) forever. An hour is long enough to come back and look at a box that
 * stopped while you were at lunch, short enough that forgetting one is cheap.
 */
export const AUTO_DELETE_MINUTES = 60

/**
 * Wall-clock life of a provisioned sandbox, in minutes.
 *
 * The hard backstop under the two intervals above: it destroys the box whatever
 * state it is in. Four hours fits a long install and a long suite with room to
 * spare, and bounds a box that was never torn down. It does NOT move the twin's
 * TTL — provision always attaches, and the twin's life was decided when whoever
 * created it said so.
 */
export const PROVISION_TTL_MINUTES = 240

/** What `provision` prints on stdout. One object, nothing else there. */
export interface ProvisionResult {
  /** The Daytona sandbox id — what `veris-daytona teardown` takes. */
  daytonaSandboxId: string
  /** The Veris twin's id. NOT the Daytona one; the receipt is read from this. */
  verisSandboxId: string
  /** The Veris environment the twin belongs to. */
  verisEnvironmentId: string
  /** Whether deleting the sandbox also deletes the twin. Always false here:
   *  provision attaches to a twin the caller made, so the caller keeps it. */
  ownsTwin: boolean
  /** An empty directory in the sandbox to put code in and run commands from. */
  workDir: string
  /** The CA bundle inside the sandbox: the public roots plus the Veris CA. */
  caBundlePath: string
  /** The CA trust variables. Export these on EVERY command — Daytona overwrites
   *  the well-known ones inside the sandbox with its own CA file, which cannot
   *  verify the gateway's certificates. */
  trustEnv: Record<string, string>
  /** The same variables as one line of shell `export`s, to prefix a command
   *  with when you have no env map to fill. */
  trustPrelude: string
  /** Run this INSIDE the sandbox after installing dependencies, to append the
   *  Veris CA to the CA bundles SDKs ship with them. */
  patchBundledCasCommand: string
  /** How to get code into the box. Daytona's own CLI has no upload, copy or
   *  sync command and its `ssh` takes no remote command, so a caller who does
   *  not know this verb exists has no route in short of writing an SDK script. */
  pushCommand: string
  /** How to run one command in the box with trustEnv already exported and its
   *  output streaming. `daytona exec` can set no variables at all. */
  execCommand: string
  /** The twin's service names — what `--require-service` would name. */
  services: string[]
  /** When Daytona destroys the sandbox regardless of state. */
  expiresAt: string
  /** Idle minutes before Daytona stops the sandbox. */
  autoStopMinutes: number
  /** Minutes after stopping before Daytona deletes it. */
  autoDeleteMinutes: number
}

export const PROVISION_USAGE = `usage: veris-daytona provision --sandbox <twin-id> [options]

Creates a Daytona sandbox whose vendor API calls are answered by an existing
Veris twin, and stops there: nothing is uploaded, nothing is run, nothing is
deleted. One JSON object is printed on stdout; progress goes to stderr.

  --sandbox <twin-id>       the Veris twin to attach to (required)
  --image <name>            Daytona image to run in (default: Daytona's default snapshot)
  --snapshot <name>         Daytona snapshot to run in
  --allow-out <host>        extra hostname the sandbox may reach (repeatable)
  --env KEY=VALUE           set as a sandbox environment variable (repeatable)

needs: DAYTONA_API_KEY, and a Veris key: VERIS_API_KEY, or the profile
\`veris login\` saved in ~/.veris/twin.yaml (VERIS_PROFILE picks one; the
environment variable wins when both exist). No VERIS_ENVIRONMENT_ID — the
environment comes from the twin. A Daytona key without delete:sandboxes still
provisions, with a warning that teardown will be refused.

the JSON on stdout:
  daytonaSandboxId        the Daytona sandbox id; \`veris-daytona teardown\` takes it
  verisSandboxId          the Veris twin's id — NOT the Daytona one
  verisEnvironmentId      the environment the twin belongs to
  ownsTwin                false: the twin is yours, and teardown leaves it alone
  workDir                 an empty directory to put code in and run commands from
  caBundlePath            the CA bundle inside the sandbox (public roots + the Veris CA)
  trustEnv                the CA variables, as a map — export them on EVERY command
  trustPrelude            the same variables as one line of shell \`export\`s
  patchBundledCasCommand  run it inside the sandbox after installing dependencies
  pushCommand             how to get code in — the Daytona CLI cannot upload
  execCommand             how to run one command in there, trustEnv already applied
  services                the twin's service names
  expiresAt               when Daytona destroys the sandbox whatever state it is in
  autoStopMinutes         idle minutes before Daytona stops it
  autoDeleteMinutes       minutes after stopping before Daytona deletes it

Getting code in: the Daytona CLI has no upload, copy or sync command, its \`ssh\`
takes no remote command, and \`--context\` is a build context on \`create\` only —
so \`veris-daytona push <daytonaSandboxId>\` is the route. It tars the current
directory into workDir. \`veris-daytona exec <daytonaSandboxId> -- <command>\`
then runs a command in there with trustEnv already exported and its output
streaming, neither of which \`daytona exec\` can do.

Data-plane variables (DATABASE_URL and the like) are already set inside the
sandbox, so a command run in there inherits them.

The sandbox stops after ${AUTO_STOP_MINUTES} idle minutes, is deleted ${AUTO_DELETE_MINUTES} minutes after
it stops, and is destroyed at ${PROVISION_TTL_MINUTES} minutes old whatever state it is in — nothing
here deletes it for you. The twin's own TTL is whatever created it.

exit code: 0 when the sandbox is up and the canary answered; 2 otherwise.`

/**
 * Flags `run` has that provision deliberately does not, each with the reason.
 *
 * A bare "unknown option" would read as a typo in this package, when the truth
 * is that the flag moved: everything about running a command and judging its
 * receipt now belongs to the `veris` CLI.
 */
const RUN_ONLY: Record<string, string> = {
  '--repo': 'provision puts no code in the sandbox — clone or upload it yourself',
  '--ref': 'provision puts no code in the sandbox — clone or upload it yourself',
  '--setup': 'provision runs no commands — install dependencies yourself in the sandbox it hands back',
  '--require-service': 'provision reads no receipt, so it judges nothing — that belongs to the `veris` CLI',
  '--timeout': 'provision runs no command, so there is nothing to time out',
  '--keep': 'provision always keeps the sandbox; delete it with `veris-daytona teardown`',
  '--environment': 'the environment comes from the twin named by --sandbox',
}

/** Parse everything after `provision`. Pure; throws UsageError with a human message. */
export function parseProvisionArgs(argv: readonly string[]): ProvisionOptions {
  const opts: ProvisionOptions = { sandbox: '', allowOut: [], env: {} }

  const takeValue = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`)
    return v
  }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (flag === '--') {
      throw new UsageError(
        `provision runs no command, so there is nothing to put after '--'. ` +
        `Use \`veris-daytona run\` for that, or run your command in the sandbox provision hands back.`)
    }
    if (flag in RUN_ONLY) throw new UsageError(`${flag} is a \`run\` flag: ${RUN_ONLY[flag]}`)
    switch (flag) {
      case '--sandbox': opts.sandbox = takeValue(i++, flag); break
      case '--image': opts.image = takeValue(i++, flag); break
      case '--snapshot': opts.snapshot = takeValue(i++, flag); break
      case '--allow-out': opts.allowOut.push(takeValue(i++, flag)); break
      case '--env': {
        const pair = takeValue(i++, flag)
        const eq = pair.indexOf('=')
        if (eq <= 0) throw new UsageError(`--env wants KEY=VALUE, got '${pair}'`)
        opts.env[pair.slice(0, eq)] = pair.slice(eq + 1)
        break
      }
      case '-h': case '--help': throw new UsageError(PROVISION_USAGE)
      default: throw new UsageError(`unknown option '${flag}'\n\n${PROVISION_USAGE}`)
    }
  }

  if (opts.image && opts.snapshot) throw new UsageError('--image and --snapshot are exclusive')
  if (!opts.sandbox) {
    throw new UsageError(
      `--sandbox is required: provision attaches to a twin that already exists ` +
      `(\`veris up\` prints its id)\n\n${PROVISION_USAGE}`)
  }
  return opts
}

/**
 * The JSON object, from the handful of facts only a live create() knows.
 *
 * Everything else in it is derived here rather than in cli.ts, so the shape a
 * caller parses is decided in one pure place and tested without an account.
 */
export function provisionResult(facts: {
  daytonaSandboxId: string
  verisSandboxId: string
  verisEnvironmentId: string
  workDir: string
  trustEnv: Record<string, string>
  services: string[]
  expiresAt: string
}): ProvisionResult {
  return {
    daytonaSandboxId: facts.daytonaSandboxId,
    verisSandboxId: facts.verisSandboxId,
    verisEnvironmentId: facts.verisEnvironmentId,
    // provision requires --sandbox, so the twin is always the caller's.
    ownsTwin: false,
    workDir: facts.workDir,
    caBundlePath: VERIS_BUNDLE,
    trustEnv: facts.trustEnv,
    trustPrelude: trustPrelude(facts.trustEnv),
    // The script is already in the sandbox — installCa uploads it at create,
    // precisely so that whoever installs the dependencies can patch the bundles
    // afterwards without holding this SDK. Naming the command here is the whole
    // of "how a caller patches bundled CAs": one line of shell, no third verb.
    patchBundledCasCommand: `sh ${BUNDLED_CA_PATCH_SCRIPT}`,
    // Named with the id already in them, because the gap this closes is a
    // caller who reads the JSON, finds workDir, and has nothing that can put a
    // file there — the trial wrote a Node script against @daytona/sdk to do it.
    pushCommand: `veris-daytona push ${facts.daytonaSandboxId}`,
    execCommand: `veris-daytona exec ${facts.daytonaSandboxId} -- <command>`,
    services: facts.services,
    expiresAt: facts.expiresAt,
    autoStopMinutes: AUTO_STOP_MINUTES,
    autoDeleteMinutes: AUTO_DELETE_MINUTES,
  }
}

/** The one line of stdout. Indented, because a human reads this too. */
export function provisionJson(result: ProvisionResult): string {
  return JSON.stringify(result, null, 2)
}
