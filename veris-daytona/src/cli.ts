// The `veris-daytona` executable. Today it has one verb, `run` — see run.ts
// for the flags and the verdict; this file is the part that talks to Daytona
// and the control plane.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Daytona, isVerisSandbox } from './daytona'
import type { VerisSandbox } from './daytona'
import { VerisError } from './errors'
import {
  TIMED_OUT_EXIT, UPLOAD_EXCLUDES, USAGE, UsageError, commandEnv, commandLine, formatReceipt, parseRunArgs, verdict,
} from './run'
import type { RunOptions } from './run'
import { SDK_VERSION } from './version'

const out = (msg: string) => process.stdout.write(msg + '\n')
const say = (msg: string) => process.stderr.write(`\x1b[1m» ${msg}\x1b[0m\n`)
const note = (msg: string) => process.stderr.write(`  \x1b[2m${msg}\x1b[0m\n`)

export async function main(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv
  if (verb === '--version' || verb === '-v') { out(SDK_VERSION); return 0 }
  if (verb !== 'run') { process.stderr.write(USAGE + '\n'); return verb === undefined || verb === '--help' || verb === '-h' ? 0 : 2 }

  let opts: RunOptions
  try {
    opts = parseRunArgs(rest)
  } catch (e) {
    if (e instanceof UsageError) { process.stderr.write(e.message + '\n'); return e.message === USAGE ? 0 : 2 }
    throw e
  }
  return run(opts)
}

async function run(opts: RunOptions): Promise<number> {
  const daytonaKey = process.env.DAYTONA_API_KEY
  if (!daytonaKey) {
    process.stderr.write('DAYTONA_API_KEY is not set. Get one at https://app.daytona.io/dashboard/keys\n')
    return 2
  }
  // Only the twin's own TTL backstop; the sandbox is deleted at the end regardless.
  const ttlMinutes = Math.ceil(opts.timeoutSeconds / 60) + 30

  say('Creating the Daytona sandbox and its Veris twin')
  const daytona = new Daytona({ apiKey: daytonaKey })
  const created = await daytona.create({
    ...(opts.image ? { image: opts.image } : {}),
    ...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
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
    const root = (await sandbox.getWorkDir()) ?? (await sandbox.getUserRootDir()) ?? '/home/daytona'
    const work = `${root.replace(/\/$/, '')}/veris-run`

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
    if (opts.keep) {
      say('Keeping the sandbox and twin (--keep)')
      note(`VERIS_SANDBOX_ID=${sandbox.verisSandboxId}`)
      note(`daytona sandbox: ${sandbox.id}`)
      note(`delete both with: daytona delete ${sandbox.id}   # the twin goes with it only via the SDK; also DELETE it in Veris`)
    } else {
      say('Deleting the sandbox and twin')
      await sandbox.delete().catch((e) => process.stderr.write(`  cleanup failed: ${e}\n`))
    }
  }
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
