// The `veris-daytona` executable. Three verbs — `run` (run.ts), `provision`
// (provision.ts) and `teardown` (teardown.ts) — whose flags and pure logic live
// in a module each; this file is the part that talks to Daytona and the control
// plane.
//
// `run` does the whole job in one command. `provision` and `teardown` are the
// same job split at the seam: provision wires a sandbox and stops, and whoever
// called it uploads code, runs a suite and decides what the receipt proved.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { DaytonaNotFoundError } from '@daytona/sdk'
import type { Sandbox } from '@daytona/sdk'
import { Daytona, isVerisSandbox, verisOwnsTwin, verisTwinId } from './daytona'
import type { VerisSandbox } from './daytona'
import { VerisError } from './errors'
import {
  TIMED_OUT_EXIT, UPLOAD_EXCLUDES, USAGE, UsageError, commandEnv, commandLine, formatReceipt,
  parseRunArgs, shellQuote, verdict,
} from './run'
import type { RunOptions } from './run'
import {
  AUTO_DELETE_MINUTES, AUTO_STOP_MINUTES, PROVISION_TTL_MINUTES, PROVISION_USAGE,
  parseProvisionArgs, provisionJson, provisionResult,
} from './provision'
import type { ProvisionOptions } from './provision'
import { TEARDOWN_USAGE, parseTeardownArgs } from './teardown'
import type { TeardownOptions } from './teardown'
import { SDK_VERSION } from './version'

const out = (msg: string) => process.stdout.write(msg + '\n')
const say = (msg: string) => process.stderr.write(`\x1b[1m» ${msg}\x1b[0m\n`)
const note = (msg: string) => process.stderr.write(`  \x1b[2m${msg}\x1b[0m\n`)

const ROOT_USAGE = `usage: veris-daytona <command> [options]

  run         run a command in a wired sandbox, print the receipt, delete everything
  provision   create a wired sandbox on an existing twin, print its JSON, and stop
  teardown    delete a sandbox that provision (or run --keep) left behind

veris-daytona <command> --help describes each one.`

/** Every text that IS the help, rather than a complaint ending in it. */
const HELP_TEXTS: readonly string[] = [ROOT_USAGE, USAGE, PROVISION_USAGE, TEARDOWN_USAGE]

export async function main(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv
  if (verb === '--version' || verb === '-v') { out(SDK_VERSION); return 0 }

  switch (verb) {
    case 'run': {
      const opts = parseOrExit(() => parseRunArgs(rest))
      return typeof opts === 'number' ? opts : run(opts)
    }
    case 'provision': {
      const opts = parseOrExit(() => parseProvisionArgs(rest))
      return typeof opts === 'number' ? opts : provision(opts)
    }
    case 'teardown': {
      const opts = parseOrExit(() => parseTeardownArgs(rest))
      return typeof opts === 'number' ? opts : teardown(opts)
    }
    default:
      process.stderr.write(ROOT_USAGE + '\n')
      return verb === undefined || verb === '--help' || verb === '-h' ? 0 : 2
  }
}

/**
 * Parse one verb's argv, or the exit code the failure deserves: 0 when the
 * caller asked for help, 2 when they got the flags wrong. Options objects are
 * never numbers, so the caller narrows on `typeof`.
 */
function parseOrExit<T extends object>(parse: () => T): T | number {
  try {
    return parse()
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    process.stderr.write(e.message + '\n')
    return HELP_TEXTS.includes(e.message) ? 0 : 2
  }
}

async function run(opts: RunOptions): Promise<number> {
  const daytonaKey = process.env.DAYTONA_API_KEY
  if (!daytonaKey) {
    process.stderr.write('DAYTONA_API_KEY is not set. Get one at https://app.daytona.io/dashboard/keys\n')
    return 2
  }
  // Only the twin's own TTL backstop; the sandbox is deleted at the end regardless.
  const ttlMinutes = Math.ceil(opts.timeoutSeconds / 60) + 30

  say(opts.sandbox ? `Creating the Daytona sandbox on twin ${opts.sandbox}` : 'Creating the Daytona sandbox and its Veris twin')
  const daytona = new Daytona({ apiKey: daytonaKey })
  const created = await daytona.create({
    ...(opts.image ? { image: opts.image } : {}),
    ...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
    // A run deletes its own sandbox, so these two only ever matter when it
    // could not: --keep, a crash, a machine that went away mid-run. Daytona's
    // own auto-stop default is 15 minutes and auto-delete is off entirely, so
    // saying them out loud is the difference between a stranded box costing an
    // hour and costing until someone notices.
    autoStopInterval: AUTO_STOP_MINUTES,
    autoDeleteInterval: AUTO_DELETE_MINUTES,
    veris: {
      environmentId: opts.environment,
      attachSandboxId: opts.sandbox,
      allowOut: opts.allowOut,
      ttlMinutes,
    },
  } as Parameters<Daytona['create']>[0], { timeout: 300 })
  if (!isVerisSandbox(created)) throw new VerisError('create() returned a sandbox with no Veris surface')
  const sandbox: VerisSandbox = created
  note(`Daytona sandbox ${sandbox.id}`)
  note(`Veris twin      ${sandbox.verisSandboxId}`)

  let code = 2
  try {
    const root = await sandboxRoot(sandbox)
    const work = `${root}/veris-run`

    if (opts.repo) {
      say(`Cloning ${opts.repo}${opts.ref ? ` (${opts.ref})` : ''}`)
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
      const auth = token && /github\.com/.test(opts.repo) ? ['x-access-token', token] as const : [undefined, undefined] as const
      await sandbox.git.clone(opts.repo, work, opts.ref, undefined, auth[0], auth[1], undefined, 1)
    } else {
      say(`Uploading ${process.cwd()}`)
      const archive = packCwd()
      note(`${(archive.length / 1024 / 1024).toFixed(1)} MB after excluding ${UPLOAD_EXCLUDES.join(', ')}`)
      await sandbox.fs.uploadFile(archive, `${root}/veris-run.tgz`, 300)
      const unpack = await sandbox.process.executeCommand(
        `mkdir -p '${work}' && tar xzf '${root}/veris-run.tgz' -C '${work}' && rm '${root}/veris-run.tgz'`,
        undefined, undefined, 120)
      if (unpack.exitCode !== 0) throw new VerisError(`unpacking the upload failed: ${unpack.result}`)
    }

    const env = commandEnv(sandbox.veris.getTrustEnv(), opts.env)

    if (opts.setup) {
      say(`Setup: ${opts.setup}`)
      const setup = await stream(sandbox, opts.setup, work, env, opts.timeoutSeconds)
      if (setup !== 0) {
        process.stderr.write(`\nsetup exited ${setup}; not running the command\n`)
        return setup
      }
    }

    // After setup, because that is when the bundles exist. An SDK that ships
    // its own CA bundle reads none of the trust variables above —
    // stripe-python passes verify=stripe.ca_bundle_path — so its first vendor
    // call fails on the certificate the gateway forged, in a sandbox where
    // curl, Node and requests are all fine. Appending our CA to those files is
    // the Daytona-shaped version of the veris CLI's --patch-bundled-cas.
    const patched = await sandbox.veris.patchBundledCas()
    for (const file of patched) note(`bundled CA ${file} — the Veris CA appended`)
    if (patched.length) note(`${patched.length} bundled CA file(s) patched`)

    say(`Running: ${opts.command}`)
    const commandExit = await stream(sandbox, opts.command, work, env, opts.timeoutSeconds)
    note(`exit ${commandExit}`)

    say('Reading the receipt')
    const receipt = await sandbox.veris.receipt()
    out('')
    out(formatReceipt(receipt, sandbox.verisSandboxId))
    const v = verdict(commandExit, receipt, opts.requireService)
    for (const p of v.problems) process.stderr.write(`\n\x1b[31m✗\x1b[0m ${p}`)
    if (v.problems.length) process.stderr.write('\n  Do not report this run as working.\n')
    code = v.exitCode
    return code
  } finally {
    // What actually happens depends on who owns the twin, and saying otherwise
    // is not a cosmetic slip: an attach run used to announce "Deleting the
    // sandbox and twin" while deleting only the sandbox, which is a line that
    // would make anyone stop looking for a twin that is still there.
    const owns = verisOwnsTwin(sandbox)
    if (opts.keep) {
      say(owns ? 'Keeping the sandbox and twin (--keep)' : 'Keeping the sandbox (--keep); the twin was already yours')
      note(`VERIS_SANDBOX_ID=${sandbox.verisSandboxId}`)
      note(`daytona sandbox: ${sandbox.id}`)
      note(owns
        ? `delete both with: veris-daytona teardown ${sandbox.id}`
        : `delete the sandbox with: veris-daytona teardown ${sandbox.id}   # your twin is left alone`)
    } else {
      say(owns ? 'Deleting the sandbox and twin' : `Deleting the sandbox; twin ${sandbox.verisSandboxId} is yours and is left running`)
      await sandbox.delete().catch((e) => process.stderr.write(`  cleanup failed: ${e}\n`))
    }
  }
}

/**
 * Create a wired sandbox on an existing twin and stop there, printing one JSON
 * object on stdout for whoever drives it next.
 *
 * Everything up to and including "the box is trusted" happens inside create():
 * the egress credential, the allowlist, the outbound proxy, the CA bundle, the
 * canary probe and the trust variables. What is deliberately absent is the rest
 * of `run` — no upload, no setup, no command, no receipt, and above all no
 * delete.
 */
async function provision(opts: ProvisionOptions): Promise<number> {
  const daytonaKey = process.env.DAYTONA_API_KEY
  if (!daytonaKey) {
    process.stderr.write('DAYTONA_API_KEY is not set. Get one at https://app.daytona.io/dashboard/keys\n')
    return 2
  }
  // Read before create, so the printed expiry is never later than the truth:
  // Daytona counts the TTL from the moment the sandbox exists, which is after
  // this line, not before it.
  const createdAt = Date.now()

  say(`Creating the Daytona sandbox on twin ${opts.sandbox}`)
  const created = await new Daytona({ apiKey: daytonaKey }).create({
    ...(opts.image ? { image: opts.image } : {}),
    ...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
    // The only place a caller's --env can land: there is no command here to
    // export it in front of, so it is set on the sandbox and every command run
    // in there inherits it. Veris-managed variables still win — see create().
    ...(Object.keys(opts.env).length ? { envVars: opts.env } : {}),
    // Load-bearing here in a way they are not in `run`: nothing deletes this
    // box afterwards, so these are what stop an abandoned one from billing.
    autoStopInterval: AUTO_STOP_MINUTES,
    autoDeleteInterval: AUTO_DELETE_MINUTES,
    veris: {
      attachSandboxId: opts.sandbox,
      allowOut: opts.allowOut,
      // The Daytona box's wall-clock backstop. It does not move the twin's own
      // TTL: an attached twin is never created here, so its life was already
      // decided by whoever made it.
      ttlMinutes: PROVISION_TTL_MINUTES,
    },
  } as Parameters<Daytona['create']>[0], { timeout: 300 })
  if (!isVerisSandbox(created)) throw new VerisError('create() returned a sandbox with no Veris surface')
  const sandbox: VerisSandbox = created
  note(`Daytona sandbox ${sandbox.id}`)
  note(`Veris twin      ${sandbox.verisSandboxId}`)

  // The caller has to put code somewhere, and a directory that already exists
  // is one fewer thing for them to get right. Made here rather than named and
  // left absent, because `cd` into it is the first thing they will do.
  const work = `${await sandboxRoot(sandbox)}/veris-run`
  const mkdir = await sandbox.process.executeCommand(`mkdir -p ${shellQuote(work)}`, undefined, undefined, 60)
  if (mkdir.exitCode !== 0) throw new VerisError(`could not create ${work} in the sandbox: ${mkdir.result}`)

  const services = await sandbox.veris.services()
  say('Ready. The sandbox is up, trusted, and running nothing')
  note(`delete it with: veris-daytona teardown ${sandbox.id}`)

  out(provisionJson(provisionResult({
    daytonaSandboxId: sandbox.id,
    verisSandboxId: sandbox.verisSandboxId,
    verisEnvironmentId: sandbox.veris.environmentId,
    workDir: work,
    trustEnv: sandbox.veris.getTrustEnv(),
    services: services.map((s) => s.name),
    // Daytona's own answer where it gives one: it is the authority on when the
    // box dies, and the local sum can only estimate the moment it began.
    expiresAt: sandbox.autoDestroyAt ?? new Date(createdAt + PROVISION_TTL_MINUTES * 60_000).toISOString(),
  })))
  return 0
}

/**
 * Delete one Daytona sandbox, and say what happened to its twin.
 *
 * The twin decision is not made here. `sandbox.delete()` already deletes a twin
 * this package created and leaves an attached one alone; teardown reads the
 * same label so that the sentence it prints and the action it takes come from
 * one fact rather than two.
 */
async function teardown(opts: TeardownOptions): Promise<number> {
  const daytonaKey = process.env.DAYTONA_API_KEY
  if (!daytonaKey) {
    process.stderr.write('DAYTONA_API_KEY is not set. Get one at https://app.daytona.io/dashboard/keys\n')
    return 2
  }

  let sandbox: Sandbox
  try {
    sandbox = await new Daytona({ apiKey: daytonaKey }).get(opts.sandboxId)
  } catch (e) {
    if (!(e instanceof DaytonaNotFoundError)) throw e
    // Said in full, because the obvious worry on reading this is the other
    // resource: a twin bills on its own and nothing here has been near it.
    process.stderr.write(
      `no Daytona sandbox '${opts.sandboxId}' — already deleted, or it belongs to another ` +
      `organization than this DAYTONA_API_KEY. No Veris twin was touched.\n`)
    return 1
  }

  const twinId = verisTwinId(sandbox)
  const owns = verisOwnsTwin(sandbox)
  if (owns && !isVerisSandbox(sandbox)) {
    // The labels say this sandbox owns a twin, and the Veris surface could not
    // be rehydrated — in practice, VERIS_API_KEY is unset. Deleting now would
    // strand the twin silently, so refuse and name the key. An ATTACHED twin
    // needs no key at all, which is why this asks about ownership and not
    // merely about a twin existing.
    process.stderr.write(
      `sandbox ${sandbox.id} owns Veris twin ${twinId} and VERIS_API_KEY is not set, so the twin ` +
      `cannot be deleted. Set it and run this again, or the twin outlives the sandbox until its ` +
      `TTL. Nothing was deleted.\n`)
    return 2
  }

  say(owns
    ? `Deleting the sandbox and twin ${twinId}`
    : twinId
      ? `Deleting the sandbox; twin ${twinId} is yours and is left running`
      : 'Deleting the sandbox (it has no Veris twin)')
  await sandbox.delete()
  note(`deleted ${sandbox.id}`)
  return 0
}

/** The sandbox's home, with no trailing slash — where both verbs put code. */
async function sandboxRoot(sandbox: Sandbox): Promise<string> {
  const root = (await sandbox.getWorkDir()) ?? (await sandbox.getUserRootDir()) ?? '/home/daytona'
  return root.replace(/\/$/, '')
}

/** tar the current directory into memory, minus what gets rebuilt inside. */
function packCwd(): Buffer {
  const args = ['czf', '-', ...UPLOAD_EXCLUDES.map((x) => `--exclude=${x}`), '-C', process.cwd(), '.']
  return execFileSync('tar', args, { maxBuffer: 1024 * 1024 * 1024 })
}

/**
 * Run a shell command in the sandbox, streaming its output as it happens, and
 * return its exit code. A session is used instead of executeCommand because
 * the latter returns only when the command ends, and a test suite can take
 * many minutes with nothing to show for it in between.
 *
 * Two timeouts guard a hung command: coreutils `timeout` inside the sandbox
 * (exit 124), and a client-side backstop a little later that drops the
 * session, for images without `timeout`. Either way the run goes on to the
 * receipt and fails on the exit code, rather than waiting for the sandbox TTL.
 */
async function stream(
  sandbox: VerisSandbox, command: string, cwd: string, env: Record<string, string>, timeoutSeconds: number,
): Promise<number> {
  const session = `veris-run-${randomUUID().slice(0, 8)}`
  await sandbox.process.createSession(session)
  let timer: NodeJS.Timeout | undefined
  try {
    const started = await sandbox.process.executeSessionCommand(
      session, { command: commandLine(cwd, env, command, timeoutSeconds), runAsync: true }, 60)
    const cmdId = started.cmdId
    if (!cmdId) throw new VerisError('Daytona did not return a command id for the session command')

    const backstopMs = (timeoutSeconds + 30) * 1000
    const backstop = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), backstopMs) })
    const logs = sandbox.process.getSessionCommandLogs(session, cmdId,
      (chunk) => process.stdout.write(chunk), (chunk) => process.stderr.write(chunk)).then(() => 'done' as const)
    if (await Promise.race([logs, backstop]) === 'timeout') {
      process.stderr.write(`\ncommand still running after ${timeoutSeconds}s; stopping it\n`)
      return TIMED_OUT_EXIT
    }

    // The log stream closing does not guarantee the exit status is recorded yet.
    const deadline = Date.now() + 30_000
    for (;;) {
      const cmd = await sandbox.process.getSessionCommand(session, cmdId)
      if (typeof cmd.exitCode === 'number') {
        if (cmd.exitCode === TIMED_OUT_EXIT) process.stderr.write(`\ncommand timed out after ${timeoutSeconds}s\n`)
        return cmd.exitCode
      }
      if (Date.now() > deadline) throw new VerisError('command finished but Daytona never reported its exit code')
      await new Promise((r) => setTimeout(r, 500))
    }
  } finally {
    if (timer) clearTimeout(timer)
    await sandbox.process.deleteSession(session).catch(() => {})
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    const e = err as { message?: string; phase?: string; cause?: unknown; responseBody?: unknown }
    process.stderr.write(`\n\x1b[31mFAILED\x1b[0m ${e?.message ?? err}\n`)
    if (e?.phase) process.stderr.write(`  phase: ${e.phase}\n`)
    if (e?.responseBody) process.stderr.write(`  body:  ${JSON.stringify(e.responseBody).slice(0, 400)}\n`)
    process.exit(2)
  },
)
