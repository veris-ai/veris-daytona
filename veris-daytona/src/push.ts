// `veris-daytona push <daytona-sandbox-id>`: put code into a Daytona sandbox
// that already exists.
//
//   veris-daytona push 7f3c1e0a-…
//   veris-daytona push 7f3c1e0a-… --repo https://github.com/you/app --ref main
//
// It is the upload half of `run`, addressed at a box `provision` handed back
// rather than at one it just made — the same `packCwd`, the same excludes, the
// same clone.
//
// It exists because Daytona has no other route. Their CLI (v0.210.0) has no
// upload, copy or sync command; `daytona ssh` takes exactly one argument, so it
// cannot carry `tar | ssh` and there is no scp or rsync behind it;
// `--context` is a Docker build context and only exists on `create`, which
// `provision` owns; and `git clone` inside the box needs the git host on an
// allowlist that was fixed at create. Without this verb the only way in is a
// hand-written Node script against @daytona/sdk, which is what the trial had to
// write.
//
// Argument parsing is pure, so it is unit tested without a Daytona account.
// Everything that touches the network is in cli.ts.
import { UPLOAD_EXCLUDES, UsageError, WORK_SUBDIR } from './run'

export interface PushOptions {
  /** The Daytona sandbox id — `provision`'s daytonaSandboxId. Not the twin's. */
  sandboxId: string
  /** Git URL to clone into the sandbox. Unset: the current directory is uploaded. */
  repo?: string
  /** Branch to clone. Only meaningful with --repo. */
  ref?: string
}

/** A comma list as lines that fit a terminal, so the usage text stays readable
 *  however the exclude list grows. */
function wrapped(words: readonly string[], width = 74): string {
  const lines: string[] = []
  for (const w of words) {
    const last = lines.at(-1)
    if (last !== undefined && `${last}, ${w}`.length <= width) lines[lines.length - 1] = `${last}, ${w}`
    else lines.push(w)
  }
  return lines.map((l) => `  ${l}`).join('\n')
}

export const PUSH_USAGE = `usage: veris-daytona push <daytona-sandbox-id> [options]

Puts code into a sandbox that already exists — the id \`veris-daytona provision\`
printed as daytonaSandboxId, not the Veris twin's. By default it tars the
current directory and unpacks it in the sandbox; --repo clones instead.

  --repo <url>              git URL to clone into the sandbox (default: upload the current directory)
  --ref <branch>            branch to clone

It lands in <sandbox home>/${WORK_SUBDIR} — the same path \`provision\` printed as
workDir, so the two chain without carrying it between them. The upload leaves
out what is rebuilt inside or is not source:

${wrapped(UPLOAD_EXCLUDES)}

Files of the same name are overwritten; anything else already in the directory
is left alone.

This verb exists because the Daytona CLI has no upload, copy or sync command,
its \`ssh\` takes no remote command, and \`--context\` is a build context on
\`create\` only.

needs: DAYTONA_API_KEY. GITHUB_TOKEN or GH_TOKEN is used for a private --repo.
A clone runs inside the sandbox, so the git host must be on the allowlist the
sandbox was created with — \`provision --allow-out github.com\`.

exit code: 0 when the code is in the sandbox; 1 when there is no such sandbox.`

/** Parse everything after `push`. Pure; throws UsageError with a human message. */
export function parsePushArgs(argv: readonly string[]): PushOptions {
  const opts: PushOptions = { sandboxId: '' }
  const ids: string[] = []

  const takeValue = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`)
    return v
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '--repo': opts.repo = takeValue(i++, arg); break
      case '--ref': opts.ref = takeValue(i++, arg); break
      case '-h': case '--help': throw new UsageError(PUSH_USAGE)
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option '${arg}'\n\n${PUSH_USAGE}`)
        ids.push(arg)
    }
  }

  if (ids.length === 0) throw new UsageError(`no sandbox id given\n\n${PUSH_USAGE}`)
  // One at a time, as teardown is: pushing the same tree to several boxes is a
  // shell loop, and a partial failure across ids has no honest exit code.
  if (ids.length > 1) throw new UsageError(`push takes one sandbox id, got ${ids.length}: ${ids.join(' ')}`)
  // A --ref with nothing to clone is silently ignored otherwise, and the
  // caller walks away believing they pushed a branch.
  if (opts.ref && !opts.repo) throw new UsageError('--ref only means something with --repo; an upload has no branch')

  opts.sandboxId = ids[0]!
  return opts
}
