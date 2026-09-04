import { describe, expect, it } from 'vitest'
import {
  DEFAULT_API_BASE, missingKeyMessage, parseProfileFile, profilePath, requireVerisCredentials,
  resolveVerisCredentials, selectProfileName,
} from '../../src/profile'
import { MissingCredentialsError, VerisError } from '../../src/errors'

/** The file exactly as `veris login` writes it (internal/cfg/global.go), two profiles. */
const FILE = `active_profile: default
profiles:
  default:
    api_base: https://svc.api.veris.ai
    api_key: vsk_prod_000
    console_url: https://studio.veris.ai
  dev:
    api_base: https://svc.dev.api.veris.ai/
    api_key: vsk_dev_000
    console_url: https://studio.dev.veris.ai
`

const PATH = '/home/u/.veris/twin.yaml'

/** A resolution over a fixed file and a fixed environment — no home directory involved. */
function resolve(env: NodeJS.ProcessEnv, text: string | null = FILE, opts: { apiKey?: string; apiBase?: string } = {}) {
  return resolveVerisCredentials({ ...opts, env, path: PATH, readFile: (p) => (p === PATH && text !== null ? text : undefined) })
}

describe('profilePath', () => {
  it('is <home>/.veris/twin.yaml, where the veris CLI keeps its profiles', () => {
    // Go's os.UserHomeDir and Node's os.homedir resolve the same directory on
    // macOS, Linux ($HOME) and Windows (%USERPROFILE%), so one join is enough.
    expect(profilePath('/home/u')).toMatch(/^\/home\/u[\\/]\.veris[\\/]twin\.yaml$/)
  })
})

describe('resolveVerisCredentials: the key', () => {
  // The defect: a customer who signed in with `veris login` has the key in
  // ~/.veris/twin.yaml and nothing in the shell, and `provision` failed with a
  // missing-key error. Exporting the key made `veris doctor` warn that the
  // shell key overrides the profile. So the profile is read when the
  // environment is silent, and only then.
  it('reads the active profile when VERIS_API_KEY is unset', () => {
    const c = resolve({})
    expect(c.apiKey).toBe('vsk_prod_000')
    expect(c.keySource).toBe('profile')
    expect(c.apiBase).toBe('https://svc.api.veris.ai')
    expect(c.baseSource).toBe('profile')
    expect(c.profile).toEqual({ name: 'default', path: PATH, found: true })
  })

  it('VERIS_API_KEY beats the profile on every command, as the CLI documents', () => {
    const c = resolve({ VERIS_API_KEY: 'vsk_shell' })
    expect(c.apiKey).toBe('vsk_shell')
    expect(c.keySource).toBe('env')
  })

  it('a key given in code beats both', () => {
    const c = resolve({ VERIS_API_KEY: 'vsk_shell' }, FILE, { apiKey: 'vsk_code' })
    expect(c.apiKey).toBe('vsk_code')
    expect(c.keySource).toBe('option')
  })

  it('VERIS_PROFILE picks the profile', () => {
    const c = resolve({ VERIS_PROFILE: 'dev' })
    expect(c.apiKey).toBe('vsk_dev_000')
    expect(c.profile.name).toBe('dev')
  })

  it('active_profile picks it when VERIS_PROFILE is unset', () => {
    const c = resolve({}, FILE.replace('active_profile: default', 'active_profile: dev'))
    expect(c.apiKey).toBe('vsk_dev_000')
    expect(c.profile.name).toBe('dev')
  })

  it('falls back to "default" when the file names no active profile', () => {
    expect(selectProfileName({}, { profiles: {} })).toBe('default')
    expect(selectProfileName({}, undefined)).toBe('default')
    expect(resolve({}, FILE.replace('active_profile: default\n', '')).apiKey).toBe('vsk_prod_000')
  })

  it('a missing file is not an error, just no key', () => {
    const c = resolve({}, null)
    expect(c.apiKey).toBeUndefined()
    expect(c.keySource).toBe('none')
    expect(c.profile.found).toBe(false)
  })

  it('a profile that is named but absent is no key, and the name is kept for the message', () => {
    const c = resolve({ VERIS_PROFILE: 'staging' })
    expect(c.apiKey).toBeUndefined()
    expect(c.profile).toEqual({ name: 'staging', path: PATH, found: false })
  })

  it('a profile with no api_key (logged out with the plane kept) is no key', () => {
    const c = resolve({}, FILE.replace('    api_key: vsk_prod_000\n', ''))
    expect(c.apiKey).toBeUndefined()
    expect(c.profile.found).toBe(true)
  })

  it('an empty VERIS_API_KEY counts as unset, as it does for the CLI', () => {
    expect(resolve({ VERIS_API_KEY: '' }).apiKey).toBe('vsk_prod_000')
  })
})

describe('resolveVerisCredentials: the base', () => {
  it('VERIS_API_BASE beats the profile', () => {
    const c = resolve({ VERIS_API_BASE: 'https://svc.other.veris.ai/' })
    expect(c.apiBase).toBe('https://svc.other.veris.ai')
    expect(c.baseSource).toBe('env')
  })

  it('the profile base still applies when only the key came from the shell — the CLI reads it that way too', () => {
    const c = resolve({ VERIS_API_KEY: 'vsk_shell', VERIS_PROFILE: 'dev' })
    expect(c.apiBase).toBe('https://svc.dev.api.veris.ai')
    expect(c.baseSource).toBe('profile')
  })

  it('is the production plane when nobody named one, and says so', () => {
    const c = resolve({}, null)
    expect(c.apiBase).toBe(DEFAULT_API_BASE)
    expect(c.baseSource).toBe('default')
  })

  it('drops a trailing slash wherever the base came from', () => {
    expect(resolve({ VERIS_PROFILE: 'dev' }).apiBase).toBe('https://svc.dev.api.veris.ai')
    expect(resolve({}, FILE, { apiBase: 'https://x.example/' }).apiBase).toBe('https://x.example')
  })
})

describe('parseProfileFile', () => {
  it('a missing file is undefined, an empty one is an empty mapping', () => {
    expect(parseProfileFile(undefined, PATH)).toBeUndefined()
    expect(parseProfileFile('', PATH)).toEqual({})
  })

  it('a file that does not parse is an error naming the path, never silently empty', () => {
    // The CLI's own rule: treating a broken file as empty would send the user
    // to log in again over a stray tab.
    expect(() => parseProfileFile('profiles: [\n', PATH)).toThrow(VerisError)
    expect(() => parseProfileFile('profiles: [\n', PATH)).toThrow(PATH)
    expect(() => parseProfileFile('- not\n- a mapping\n', PATH)).toThrow(/expected a mapping/)
  })
})

describe('when neither the environment nor the profile has a key', () => {
  it('requireVerisCredentials throws MissingCredentialsError in the credentials phase', () => {
    let caught: unknown
    try {
      requireVerisCredentials({ env: {}, path: PATH, readFile: () => undefined })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(MissingCredentialsError)
    expect((caught as MissingCredentialsError).phase).toBe('credentials')
  })

  it('the message says where a key can come from: the variable, the file, `veris login`, the studio', () => {
    const m = missingKeyMessage(resolve({}, null))
    expect(m).toContain('VERIS_API_KEY is not set')
    expect(m).toContain(`${PATH} has no profile 'default'`)
    expect(m).toContain('veris login')
    expect(m).toContain('VERIS_PROFILE')
    expect(m).toContain('https://studio.veris.ai')
  })

  it('names the profile that was looked for, and whether it exists without a key', () => {
    expect(missingKeyMessage(resolve({ VERIS_PROFILE: 'staging' }))).toContain(`has no profile 'staging'`)
    expect(missingKeyMessage(resolve({}, FILE.replace('    api_key: vsk_prod_000\n', ''))))
      .toContain(`profile 'default' in ${PATH} has no api_key`)
  })

  it('does not throw when a key exists anywhere', () => {
    expect(requireVerisCredentials({ env: {}, path: PATH, readFile: () => FILE }).apiKey).toBe('vsk_prod_000')
    expect(requireVerisCredentials({ env: { VERIS_API_KEY: 'k' }, path: PATH, readFile: () => undefined }).apiKey).toBe('k')
  })
})
