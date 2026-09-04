// The `veris-daytona` executable. Five verbs — `run` (run.ts), `provision`
// (provision.ts), `push` (push.ts), `exec` (exec.ts) and `teardown`
// (teardown.ts) — whose flags and pure logic live in a module each; this file
// is the part that talks to Daytona and the control plane.
//
// `run` does the whole job in one command. The other four are the same job cut
// into the pieces a caller drives itself: provision wires a sandbox and stops,
// push puts code in it, exec runs a command in it, teardown deletes it. Reading
// the receipt and deciding what it proved belongs to the `veris` CLI, so none
// of the four does it — that is the seam, and the reason they exist.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { DaytonaNotFoundError } from '@daytona/sdk'
import type { Sandbox } from '@daytona/sdk'
import { Daytona, isVerisSandbox, verisOwnsTwin, verisTwinId } from './daytona'
import type { VerisSandbox } from './daytona'
import { VerisError } from './errors'
import {
  TIMED_OUT_EXIT, UPLOAD_EXCLUDES, USAGE, UsageError, WORK_SUBDIR, commandEnv, commandLine,
  formatReceipt, parseRunArgs, shellQuote, verdict,
} from './run'
import type { RunOptions } from './run'
import { PUSH_USAGE, parsePushArgs } from './push'
import type { PushOptions } from './push'
import { EXEC_USAGE, parseExecArgs } from './exec'
import type { ExecOptions } from './exec'
import { BUNDLED_CA_PATCHED_MARKER, vendoredTrustEnv } from './trust'
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
  push        put code into a sandbox that already exists
  exec        run one command in a sandbox, with the Veris trust environment applied
  teardown    delete a sandbox that provision (or run --keep) left behind

veris-daytona <command> --help describes each one.`

/** Every text that IS the help, rather than a complaint ending in it. */
const HELP_TEXTS: readonly string[] = [ROOT_USAGE, USAGE, PROVISION_USAGE, PUSH_USAGE, EXEC_USAGE, TEARDOWN_USAGE]

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
    case 'push': {
      const opts = parseOrExit(() => parsePushArgs(rest))
      return typeof opts === 'number' ? opts : push(opts)
    }
    case 'exec': {
      const opts = parseOrExit(() => parseExecArgs(rest))
      return typeof opts === 'number' ? opts : exec(opts)
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
  const daytonaKey = requireDaytonaKey()
  if (!daytonaKey) return 2
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
    const work = `${root}/${WORK_SUBDIR}`

    await putCode(sandbox, root, work, opts.repo, opts.ref)

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
    // The script's own wording, deliberately: a caller who runs
    // patchBundledCasCommand by hand in a provisioned box sees these exact
    // lines, and two routes to one act should not read as two different acts.
    for (const file of patched) note(`${BUNDLED_CA_PATCHED_MARKER}${file}`)
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
  const daytonaKey = requireDaytonaKey()
  if (!daytonaKey) return 2
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
  const work = `${await sandboxRoot(sandbox)}/${WORK_SUBDIR}`
  const mkdir = await sandbox.process.executeCommand(`mkdir -p ${shellQuote(work)}`, undefined, undefined, 60)
  if (mkdir.exitCode !== 0) throw new VerisError(`could not create ${work} in the sandbox: ${mkdir.result}`)

  const services = await sandbox.veris.services()
  say('Ready. The sandbox is up, trusted, and running nothing')
  // The Daytona CLI can do none of these three — no upload command, no way to
  // set a variable on exec — so naming them here is not decoration.
  note(`put code in:   veris-daytona push ${sandbox.id}`)
  note(`run something: veris-daytona exec ${sandbox.id} -- <command>`)
  note(`delete it:     veris-daytona teardown ${sandbox.id}`)

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
 * Put code into a sandbox that already exists.
 *
 * The upload half of `run`, pointed at a box `provision` handed back. It is a
 * verb rather than a documented one-liner because Daytona offers no one-liner:
 * their CLI has no upload, copy or sync command, `daytona ssh` takes exactly
 * one argument so `tar | ssh` is not available and there is no scp or rsync,
 * and `--context` is a Docker build context that only exists on `create`. The
 * trial that ran the whole provision workflow end to end had to write a Node
 * script against @daytona/sdk to get a tarball in, and retype the fifteen
 * excludes by hand.
 */
async function push(opts: PushOptions): Promise<number> {
  const daytonaKey = requireDaytonaKey()
  if (!daytonaKey) return 2

  const sandbox = await getSandbox(daytonaKey, opts.sandboxId)
  if (typeof sandbox === 'number') return sandbox

  const root = await sandboxRoot(sandbox)
  await putCode(sandbox, root, `${root}/${WORK_SUBDIR}`, opts.repo, opts.ref)
  return 0
}

/**
 * Run one command in a sandbox that already exists, with the trust environment
 * applied and the output streaming.
 *
 * The command half of `run` minus the receipt and the verdict, which the
 * `veris` CLI owns: take a watermark before this and read
 * `veris sandbox trace --since` after. What it keeps is the part `daytona exec`
 * cannot do — it has no --env flag at all, so a command run through it inherits
 * Daytona's own CA file and fails on the gateway's certificate unless the
 * caller remembers the trust prelude every single time; and it returns nothing
 * until the command ends, which is fine for a 9-second install and useless for
 * a 10-minute suite.
 */
async function exec(opts: ExecOptions): Promise<number> {
  const daytonaKey = requireDaytonaKey()
  if (!daytonaKey) return 2

  const sandbox = await getSandbox(daytonaKey, opts.sandboxId)
  if (typeof sandbox === 'number') return sandbox

  // A box with no twin has no gateway to trust, and pointing its command at a
  // CA bundle that was never assembled would break TLS that currently works.
  // The map itself is a constant, so a sandbox whose Veris surface could not be
  // rehydrated — no VERIS_API_KEY — still gets the right values: this verb
  // needs only a Daytona key.
  const wired = verisTwinId(sandbox) !== undefined
  if (!wired) note(`${sandbox.id} has no Veris twin, so there is no trust environment to apply`)
  const trust = !wired ? {} : isVerisSandbox(sandbox) ? sandbox.veris.getTrustEnv() : vendoredTrustEnv()

  const cwd = opts.cwd ?? `${await sandboxRoot(sandbox)}/${WORK_SUBDIR}`
  say(`Running in ${cwd}: ${opts.command}`)
  const code = await stream(sandbox, opts.command, cwd, commandEnv(trust, opts.env), opts.timeoutSeconds)
  note(`exit ${code}`)
  return code
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
  const daytonaKey = requireDaytonaKey()
  if (!daytonaKey) return 2

  // Said in full, because the obvious worry on reading a missing sandbox is the
  // other resource: a twin bills on its own and nothing here has been near it.
  const sandbox = await getSandbox(daytonaKey, opts.sandboxId, ' No Veris twin was touched.')
  if (typeof sandbox === 'number') return sandbox

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

/** DAYTONA_API_KEY, or undefined after saying where one comes from. */
function requireDaytonaKey(): string | undefined {
  const key = process.env.DAYTONA_API_KEY
  if (!key) process.stderr.write('DAYTONA_API_KEY is not set. Get one at https://app.daytona.io/dashboard/keys\n')
  return key
}

/**
 * One sandbox by id, or the exit code a missing one deserves.
 *
 * Not found is 1 rather than a stack trace: it is the ordinary outcome of
 * acting on a box that expired or belongs to another organization, and the id
 * alone looks identical in both cases, so the message names both. `tail` is
 * whatever else the verb owes the reader about what it did NOT touch.
 */
async function getSandbox(apiKey: string, id: string, tail = ''): Promise<Sandbox | number> {
  try {
    return await new Daytona({ apiKey }).get(id)
  } catch (e) {
    if (!(e instanceof DaytonaNotFoundError)) throw e
    process.stderr.write(
      `no Daytona sandbox '${id}' — already deleted, or it belongs to another ` +
      `organization than this DAYTONA_API_KEY.${tail}\n`)
    return 1
  }
}

/**
 * Put the caller's code in the sandbox: a shallow clone when they named a repo,
 * the current directory tarred otherwise.
 *
 * Shared by `run` and `push` because they are the same act at two moments — one
 * on a box it just created, one on a box someone else provisioned. Sharing it
 * is also what keeps UPLOAD_EXCLUDES a single list: the trial retyped all
 * fifteen by hand, which is the kind of thing that goes wrong quietly.
 */
async function putCode(
  sandbox: Sandbox, root: string, work: string, repo?: string, ref?: string,
): Promise<void> {
  if (repo) {
    say(`Cloning ${repo}${ref ? ` (${ref})` : ''}`)
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
    const auth = token && /github\.com/.test(repo) ? ['x-access-token', token] as const : [undefined, undefined] as const
    await sandbox.git.clone(repo, work, ref, undefined, auth[0], auth[1], undefined, 1)
    note(`cloned into ${work}`)
    return
  }
  say(`Uploading ${process.cwd()}`)
  const archive = packCwd()
  note(`${(archive.length / 1024 / 1024).toFixed(1)} MB after excluding ${UPLOAD_EXCLUDES.join(', ')}`)
  const tgz = `${root}/${WORK_SUBDIR}.tgz`
  await sandbox.fs.uploadFile(archive, tgz, 300)
  const unpack = await sandbox.process.executeCommand(
    `mkdir -p ${shellQuote(work)} && tar xzf ${shellQuote(tgz)} -C ${shellQuote(work)} && rm ${shellQuote(tgz)}`,
    undefined, undefined, 120)
  if (unpack.exitCode !== 0) throw new VerisError(`unpacking the upload failed: ${unpack.result}`)
  note(`unpacked into ${work}`)
}

/** The sandbox's home, with no trailing slash — where every verb puts code. */
async function sandboxRoot(sandbox: Sandbox): Promise<string> {
  const root = (await sandbox.getWorkDir()) ?? (await sandbox.getUserRootDir()) ?? '/home/daytona'
  return root.replace(/\/$/, '')
}

/** tar the current directory into memory, minus what gets rebuilt inside. */
function packCwd(): Buffer {
  const args = ['czf', '-', ...UPLOAD_EXCLUDES.map((x) => `--exclude=${x}`), '-C', process.cwd(), '.']
  return execFileSync('tar', args, {
    maxBuffer: 1024 * 1024 * 1024,
    // macOS bsdtar writes an AppleDouble `._name` beside every file it packs.
    // Measured in the sandbox: a two-file upload arrived as `smoke.py`,
    // `trust_check.py`, `._smoke.py`, `._trust_check.py` and a bare `._.` —
    // resource forks for a Linux box that will never read one. The variable is
    // ignored everywhere else, so it costs nothing on Linux.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
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
  sandbox: Sandbox, command: string, cwd: string, env: Record<string, string>, timeoutSeconds: number,
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
