// Where the Veris key and control plane come from when nothing in the shell
// says: the `veris` CLI's own login profile.
//
// `veris login` saves the key to ~/.veris/twin.yaml (mode 0600) under a
// profile, and a customer who signed in that way has nothing in their
// environment. Reading only process.env here meant `provision` failed with a
// missing-key error on a machine the CLI was perfectly happy on — and exporting
// the key by hand to get past it made `veris doctor` warn that the shell key
// now overrides the profile.
//
// The precedence is the CLI's, from its README ("Profiles and CI") and
// internal/cfg/resolve.go, minus the flags this package does not have:
//
//   key:      VERIS_API_KEY  → the profile's api_key
//   base:     VERIS_API_BASE → the profile's api_base → https://svc.api.veris.ai
//   profile:  VERIS_PROFILE  → active_profile in the file → "default"
//
// VERIS_API_KEY beats the profile on every command, and when it is set the
// profile's key is never read. The file's own api_base still applies then,
// exactly as the CLI does it.
//
// The file is the same on macOS, Linux and Windows: the CLI's Go code joins
// os.UserHomeDir() with ".veris", and Node's os.homedir() resolves the same
// directory on all three ($HOME, or %USERPROFILE% on Windows).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { MissingCredentialsError, VerisError } from './errors'

export const DEFAULT_API_BASE = 'https://svc.api.veris.ai'

/** The profile file's shape, as the CLI writes it (internal/cfg/global.go). */
export interface ProfileFile {
  active_profile?: string
  profiles?: Record<string, { api_base?: string; api_key?: string } | null>
}

/** Where a key and a control plane were finally found. */
export interface VerisCredentials {
  apiKey?: string
  apiBase: string
  /** Which layer answered for the key. `none` when nothing did. */
  keySource: 'option' | 'env' | 'profile' | 'none'
  /** Which layer answered for the base. `default` means nobody named one —
   *  which matters to a caller deciding whether the base is a trusted source. */
  baseSource: 'option' | 'env' | 'profile' | 'default'
  /** The profile that was (or would have been) read, and whether it exists. */
  profile: { name: string; path: string; found: boolean }
}

export interface ResolveOpts {
  /** A key given in code, which wins over everything. */
  apiKey?: string
  /** A base given in code, which wins over everything. */
  apiBase?: string
  /** The environment to read; defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** The profile file's path; defaults to ~/.veris/twin.yaml. */
  path?: string
  /** Reads the file, or returns undefined when it does not exist. Injected
   *  so the resolution is testable without touching the home directory. */
  readFile?: (path: string) => string | undefined
}

/** ~/.veris/twin.yaml, resolved the way the CLI resolves it. */
export function profilePath(home: string = homedir()): string {
  return join(home, '.veris', 'twin.yaml')
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

/**
 * Parse the profile file. A missing file is not an error: a fresh machine has
 * none, and the caller says what to do about that. A file that exists but
 * does not parse IS an error naming the path, because silently treating it as
 * empty would send the user to log in again over a stray tab — the CLI's own
 * rule, kept so the two agree about the same file.
 */
export function parseProfileFile(text: string | undefined, path: string): ProfileFile | undefined {
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch (cause) {
    throw new VerisError(`${path} is not valid YAML`, { phase: 'credentials', cause })
  }
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VerisError(`${path} is not a profile file (expected a mapping)`, { phase: 'credentials' })
  }
  return parsed as ProfileFile
}

/** Which profile a command uses: VERIS_PROFILE → active_profile → default. */
export function selectProfileName(env: NodeJS.ProcessEnv, file: ProfileFile | undefined): string {
  return env.VERIS_PROFILE || file?.active_profile || 'default'
}

/**
 * The key and control plane this process should use, and where each came
 * from. Never throws for a missing key — that is a decision for the caller,
 * which knows whether it needs one — but does throw for a file it cannot read.
 */
export function resolveVerisCredentials(opts: ResolveOpts = {}): VerisCredentials {
  const env = opts.env ?? process.env
  const path = opts.path ?? profilePath()
  const file = parseProfileFile((opts.readFile ?? readOrUndefined)(path), path)
  const name = selectProfileName(env, file)
  const profile = file?.profiles?.[name] ?? undefined
  const found = profile !== undefined && profile !== null

  const apiKey = opts.apiKey || env.VERIS_API_KEY || (found ? profile.api_key : undefined) || undefined
  const keySource: VerisCredentials['keySource'] =
    opts.apiKey ? 'option' : env.VERIS_API_KEY ? 'env' : apiKey ? 'profile' : 'none'
  const profileBase = found ? profile.api_base : undefined
  const apiBase = (opts.apiBase || env.VERIS_API_BASE || profileBase || DEFAULT_API_BASE).replace(/\/$/, '')
  const baseSource: VerisCredentials['baseSource'] =
    opts.apiBase ? 'option' : env.VERIS_API_BASE ? 'env' : profileBase ? 'profile' : 'default'

  return { apiKey, apiBase, keySource, baseSource, profile: { name, path, found } }
}

/** "VERIS_API_KEY is not set, and …" — the two places a key was looked for. */
export function missingKeyWhere(c: VerisCredentials): string {
  const where = c.profile.found
    ? `profile '${c.profile.name}' in ${c.profile.path} has no api_key`
    : `${c.profile.path} has no profile '${c.profile.name}'`
  return `VERIS_API_KEY is not set, and ${where}`
}

/** "Run `veris login` … or set VERIS_API_KEY" — where a key can come from. */
export const KEY_SOURCES_HINT =
  'Run `veris login` (the veris CLI saves the key there; `--profile <name>` for another plane, ' +
  'and VERIS_PROFILE picks it here), or set VERIS_API_KEY in the environment. ' +
  'Get a key at https://studio.veris.ai'

/**
 * What to say when no key was found anywhere: name every place one could
 * have come from, so the fix is on the screen. `veris login` is first because
 * it is the route that needs nothing typed into a shell.
 */
export function missingKeyMessage(c: VerisCredentials): string {
  return `no Veris API key: ${missingKeyWhere(c)}. ${KEY_SOURCES_HINT}`
}

/** resolveVerisCredentials, or a MissingCredentialsError that says where a key can come from. */
export function requireVerisCredentials(opts: ResolveOpts = {}): VerisCredentials & { apiKey: string } {
  const c = resolveVerisCredentials(opts)
  if (!c.apiKey) throw new MissingCredentialsError(missingKeyMessage(c), { phase: 'credentials' })
  return c as VerisCredentials & { apiKey: string }
}
