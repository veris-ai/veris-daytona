// `veris-daytona exec <daytona-sandbox-id> -- <command>`: run one command in a
// Daytona sandbox that already exists, with the Veris trust environment
// applied, streaming its output as it happens.
//
//   veris-daytona exec 7f3c1e0a-… -- pip install -e .
//   veris-daytona exec 7f3c1e0a-… --timeout 900 -- pytest tests/integration
//
// It is the command half of `run` — the same session, the same live output, the
// same `timeout` guard — addressed at a box `provision` handed back. What it
// deliberately does NOT carry over is the receipt and the verdict: the `veris`
// CLI owns those now, and a second implementation here is how this one drifted.
//
// The trust environment is why the verb exists rather than deferring to
// `daytona exec`. Theirs has no --env flag at all (only --cwd and --timeout),
// and Daytona overwrites SSL_CERT_FILE, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE and
// NODE_EXTRA_CA_CERTS inside the sandbox with its own CA file, which cannot
// verify the gateway's certificates — so every command through their CLI has to
// be hand-prefixed with the trust prelude, once per command, forever. It also
// returns nothing until the command ends, which is fine for a 9-second install
// and useless for a 10-minute suite.
//
// Argument parsing is pure, so it is unit tested without a Daytona account.
// Everything that touches the network is in cli.ts.
import { DEFAULT_TIMEOUT_SECONDS, UsageError, WORK_SUBDIR, shellJoin } from './run'

export interface ExecOptions {
  /** The Daytona sandbox id — `provision`'s daytonaSandboxId. Not the twin's. */
  sandboxId: string
  /** Directory to run in. Unset: the same workDir `provision` printed. */
  cwd?: string
  /** KEY=VALUE pairs exported on top of the trust environment. */
  env: Record<string, string>
  /** Seconds the command may run. */
  timeoutSeconds: number
  /** The command itself, everything after `--`. */
  command: string
}

export const EXEC_USAGE = `usage: veris-daytona exec <daytona-sandbox-id> [options] -- <command>

Runs <command> in a sandbox that already exists — the id \`veris-daytona
provision\` printed as daytonaSandboxId — with the Veris trust environment
applied, and streams the output as it happens.

  --cwd <dir>               directory to run in (default: <sandbox home>/${WORK_SUBDIR}, provision's workDir)
  --env KEY=VALUE           exported on top of the trust environment (repeatable)
  --timeout <seconds>       how long <command> may run (default: ${DEFAULT_TIMEOUT_SECONDS})

The trust environment is applied for you, and that is the point of the verb:
Daytona overwrites SSL_CERT_FILE, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE and
NODE_EXTRA_CA_CERTS inside the sandbox with its own CA file, which cannot verify
the twin gateway's certificates, and \`daytona exec\` has no way to set a variable
at all. Every command here is run with the Veris values exported in front of it.
--env is applied after them and wins.

Output streams rather than arriving at the end, so a long install or suite shows
its progress. No receipt is read and no verdict is passed — take a watermark
before and read \`veris sandbox trace --since\` after.

needs: DAYTONA_API_KEY.

exit code: the command's own. 124 when it ran out of --timeout; 1 when there is
no such sandbox; 2 on a usage error.`

/** Parse everything after `exec`. Pure; throws UsageError with a human message. */
export function parseExecArgs(argv: readonly string[]): ExecOptions {
  const opts: ExecOptions = { sandboxId: '', env: {}, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, command: '' }
  const sep = argv.indexOf('--')
  const flags = sep === -1 ? [...argv] : argv.slice(0, sep)
  const command = sep === -1 ? [] : argv.slice(sep + 1)
  const ids: string[] = []

  const takeValue = (i: number, flag: string): string => {
    const v = flags[i + 1]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`)
    return v
  }

  for (let i = 0; i < flags.length; i++) {
    const arg = flags[i]!
    switch (arg) {
      case '--cwd': opts.cwd = takeValue(i++, arg); break
      case '--env': {
        const pair = takeValue(i++, arg)
        const eq = pair.indexOf('=')
        if (eq <= 0) throw new UsageError(`--env wants KEY=VALUE, got '${pair}'`)
        opts.env[pair.slice(0, eq)] = pair.slice(eq + 1)
        break
      }
      case '--timeout': {
        const n = Number(takeValue(i++, arg))
        if (!Number.isFinite(n) || n <= 0) throw new UsageError('--timeout wants a positive number of seconds')
        opts.timeoutSeconds = n
        break
      }
      case '-h': case '--help': throw new UsageError(EXEC_USAGE)
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option '${arg}'\n\n${EXEC_USAGE}`)
        ids.push(arg)
    }
  }

  if (ids.length === 0) throw new UsageError(`no sandbox id given\n\n${EXEC_USAGE}`)
  if (ids.length > 1) throw new UsageError(`exec takes one sandbox id, got ${ids.length}: ${ids.join(' ')}`)
  // Without the separator the command's own flags would be read as ours, and
  // `exec box -- ls -h` would print this help instead of listing anything.
  if (command.length === 0) throw new UsageError(`no command given: put it after '--'\n\n${EXEC_USAGE}`)

  opts.sandboxId = ids[0]!
  opts.command = shellJoin(command)
  return opts
}
