// `veris-daytona run`: one command that runs a test suite in a Daytona sandbox
// whose vendor calls are answered by a Veris twin, and prints the receipt.
//
//   veris-daytona run --repo https://github.com/you/app -- pytest tests/integration
//   veris-daytona run --setup 'npm ci' -- npm test          # uploads the cwd
//
// It is the CLI face of Daytona.create(): sandbox + twin up, code in, command
// run, receipt read, everything down. The exit code is the command's, except
// that a green suite whose twin saw nothing exits 1 — a pass without a receipt
// is not a pass.
//
// Argument parsing and the receipt verdict are pure, so they are unit tested
// without a Daytona account. Everything that touches the network is in cli.ts.
import type { Receipt } from './receipt'

export interface RunOptions {
  /** Git URL to clone into the sandbox. Unset: the current directory is uploaded. */
  repo?: string
  /** Branch to clone. */
  ref?: string
  /** Veris environment. Unset: VERIS_ENVIRONMENT_ID. */
  environment?: string
  /** Attach to an existing twin instead of creating one. It is not deleted afterwards. */
  sandbox?: string
  /** Daytona image or snapshot to create the sandbox from. Unset: Daytona's default. */
  image?: string
  snapshot?: string
  /** Shell command run once before the main command (dependency install). */
  setup?: string
  /** Services the receipt must show traffic for. Empty: any service will do. */
  requireService: string[]
  /** Extra hostnames the sandbox may reach. */
  allowOut: string[]
  /** KEY=VALUE pairs exported to the setup and main commands. */
  env: Record<string, string>
  /** Keep the sandbox and twin after the run, and print how to reach them. */
  keep: boolean
  /** Seconds the main command may run. */
  timeoutSeconds: number
  /** The command itself, everything after `--`. */
  command: string
}

export const DEFAULT_TIMEOUT_SECONDS = 1800

export const USAGE = `usage: veris-daytona run [options] -- <command>

Runs <command> in a Daytona sandbox whose vendor API calls are answered by a
Veris twin, then prints what the twin received.

  --repo <url>              git URL to clone into the sandbox (default: upload the current directory)
  --ref <branch>            branch to clone
  --environment <id>        Veris environment (default: $VERIS_ENVIRONMENT_ID)
  --sandbox <twin-id>       attach to an existing twin instead of creating one
  --image <name>            Daytona image to run in (default: Daytona's default snapshot)
  --snapshot <name>         Daytona snapshot to run in
  --setup <cmd>             shell command run first, e.g. 'npm ci' or 'pip install -e .'
  --require-service <name>  the receipt must show this service (repeatable; default: any)
  --allow-out <host>        extra hostname the sandbox may reach (repeatable)
  --env KEY=VALUE           exported to the setup and main commands (repeatable)
  --timeout <seconds>       how long <command> may run (default: ${DEFAULT_TIMEOUT_SECONDS})
  --keep                    leave the sandbox and twin running afterwards

needs: DAYTONA_API_KEY, VERIS_API_KEY, and VERIS_ENVIRONMENT_ID (or --environment).
GITHUB_TOKEN or GH_TOKEN is used for a private --repo.

exit code: the command's; 1 if the twin received nothing (a pass without a receipt is not a pass).`

export class UsageError extends Error {}

/** Parse everything after `run`. Pure; throws UsageError with a human message. */
export function parseRunArgs(argv: readonly string[]): RunOptions {
  const opts: RunOptions = {
    requireService: [], allowOut: [], env: {}, keep: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, command: '',
  }
  const sep = argv.indexOf('--')
  const flags = sep === -1 ? [...argv] : argv.slice(0, sep)
  const command = sep === -1 ? [] : argv.slice(sep + 1)

  const takeValue = (i: number, flag: string): string => {
    const v = flags[i + 1]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`)
    return v
  }

  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!
    switch (flag) {
      case '--repo': opts.repo = takeValue(i++, flag); break
      case '--ref': opts.ref = takeValue(i++, flag); break
      case '--environment': opts.environment = takeValue(i++, flag); break
      case '--sandbox': opts.sandbox = takeValue(i++, flag); break
      case '--image': opts.image = takeValue(i++, flag); break
      case '--snapshot': opts.snapshot = takeValue(i++, flag); break
      case '--setup': opts.setup = takeValue(i++, flag); break
      case '--require-service': opts.requireService.push(takeValue(i++, flag)); break
      case '--allow-out': opts.allowOut.push(takeValue(i++, flag)); break
      case '--env': {
        const pair = takeValue(i++, flag)
        const eq = pair.indexOf('=')
        if (eq <= 0) throw new UsageError(`--env wants KEY=VALUE, got '${pair}'`)
        opts.env[pair.slice(0, eq)] = pair.slice(eq + 1)
        break
      }
      case '--timeout': {
        const n = Number(takeValue(i++, flag))
        if (!Number.isFinite(n) || n <= 0) throw new UsageError('--timeout wants a positive number of seconds')
        opts.timeoutSeconds = n
        break
      }
      case '--keep': opts.keep = true; break
      case '-h': case '--help': throw new UsageError(USAGE)
      default: throw new UsageError(`unknown option '${flag}'\n\n${USAGE}`)
    }
  }

  if (opts.image && opts.snapshot) throw new UsageError('--image and --snapshot are exclusive')
  if (command.length === 0) throw new UsageError(`no command given: put it after '--'\n\n${USAGE}`)
  opts.command = shellJoin(command)
  return opts
}

/** Quote argv words back into one shell line, leaving plain words alone. */
export function shellJoin(words: readonly string[]): string {
  return words.map((w) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ')
}

export interface Verdict {
  /** The process exit code the run should end with. */
  exitCode: number
  /** One line per reason, for the human. Empty when everything held. */
  problems: string[]
}

/**
 * Decide the exit code from the command's own status and the receipt.
 *
 * A failing command fails the run, receipt or not. A passing command still
 * fails the run when the twin saw nothing, or saw nothing for a service the
 * caller required — that is the case the receipt exists to catch.
 */
export function verdict(commandExitCode: number, receipt: Receipt, requireService: readonly string[]): Verdict {
  const problems: string[] = []
  const seen = (name: string) => (receipt.services[name]?.requests ?? 0) > 0
  const total = Object.values(receipt.services).reduce((n, e) => n + (e?.requests ?? 0), 0)

  if (requireService.length > 0) {
    for (const name of requireService) {
      if (!(name in receipt.services)) problems.push(`the twin has no service named '${name}'`)
      else if (!seen(name)) problems.push(`'${name}' received ZERO requests — the code under test never called it`)
    }
  } else if (total === 0) {
    problems.push('the twin received ZERO requests — the code under test never called any vendor')
  }

  if (commandExitCode !== 0) return { exitCode: commandExitCode, problems }
  return { exitCode: problems.length ? 1 : 0, problems }
}

/** The receipt as the human sees it. */
export function formatReceipt(receipt: Receipt, twinId: string): string {
  const lines = [`Veris receipt — twin ${twinId}`, `  interception: ${receipt.mode}   integrity: ${receipt.integrity}`]
  if (receipt.leaks.length) lines.push(`  blind spots: ${receipt.leaks.join(', ')}`)
  const entries = Object.entries(receipt.services)
  const total = entries.reduce((n, [, e]) => n + (e?.requests ?? 0), 0)
  lines.push('', `${total} request(s) reached the twin:`)
  for (const [name, entry] of entries) {
    lines.push(`  ${name}: ${entry?.requests ?? 0} request(s)`)
    for (const r of (entry?.entries ?? []).slice(0, 20)) {
      lines.push(`    ${r.method} ${r.path} -> ${r.status ?? 'no response'}`)
    }
    if ((entry?.entries.length ?? 0) > 20) lines.push(`    … ${entry!.entries.length - 20} more`)
  }
  return lines.join('\n')
}

/** Directories never worth shipping: rebuilt inside the sandbox, or not source. */
export const UPLOAD_EXCLUDES: readonly string[] = [
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', 'dist', 'build', 'target', '.next', '.turbo', 'coverage', '.DS_Store',
]

/** Exit status coreutils `timeout` reports when it had to stop the command. */
export const TIMED_OUT_EXIT = 124

/**
 * The one shell line a session runs: cd, exports, then the command under
 * coreutils `timeout` so a hung suite is stopped inside the sandbox. Images
 * without `timeout` run the command bare; the client-side backstop still
 * applies.
 */
export function commandLine(cwd: string, env: Record<string, string>, command: string, timeoutSeconds: number): string {
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)};`).join(' ')
  const q = shellQuote(command)
  return `cd ${shellQuote(cwd)} && ${exports} if command -v timeout >/dev/null 2>&1; ` +
    `then timeout -k 10 ${Math.ceil(timeoutSeconds)} sh -c ${q}; else sh -c ${q}; fi`
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
