import { describe, expect, it, vi, afterEach } from 'vitest'
import { Daytona as BaseDaytona } from '@daytona/sdk'
import { Daytona, reapFailedCreate, sandboxCreateMessage } from '../../src/daytona'
import { VerisError } from '../../src/errors'

const CREATE_ID = 'create-1'

/** The reason Daytona's own record carried for the trial's failed build. */
const REAL_REASON =
  'studioops-api-test: failed to resolve source metadata for docker.io/library/' +
  'studioops-api-test:latest: pull access denied, repository does not exist or may require ' +
  'authorization: server message: insufficient_scope: authorization failed'

/** What the SDK threw for it — the id is there, the reason is not. */
const SDK_ERROR = new Error(
  'Sandbox 7ba4ecbc-1111-2222-3333-444455556666 failed to start with status: build_failed, ' +
  'error reason: null')

/**
 * A Daytona sandbox as the reaper sees it: a list row, plus whatever a refetch
 * would add. `onRefresh` stands in for the record the server actually holds.
 */
function listRow(opts: {
  id?: string
  createId?: string | undefined
  state?: string
  errorReason?: string
  onRefresh?: { errorReason?: string }
  deleteFails?: boolean
} = {}) {
  const row = {
    id: opts.id ?? 'dtn_1',
    state: opts.state ?? 'build_failed',
    errorReason: opts.errorReason,
    labels: (opts.createId === undefined ? {} : { veris_create_id: opts.createId }) as Record<string, string>,
    refreshes: 0,
    deletes: 0,
    async refreshData() {
      row.refreshes++
      if (opts.onRefresh?.errorReason) row.errorReason = opts.onRefresh.errorReason
    },
    async delete() {
      row.deletes++
      if (opts.deleteFails) throw new Error('403 forbidden')
    },
  }
  return row
}

/** A list() that records the labels it was asked for and yields the given rows. */
function lister(rows: ReturnType<typeof listRow>[]) {
  const asked: Record<string, string>[] = []
  const list = (labels: Record<string, string>) => {
    asked.push(labels)
    return (async function* () { for (const r of rows) yield r })()
  }
  return { list, asked }
}

describe('reapFailedCreate deletes the sandbox a failed create left behind', () => {
  // The leak this exists for: `run --image studioops-api-test` was an image
  // that only existed on the engineer's laptop. Daytona built it server-side,
  // the build failed, and because the SDK only hands back a Sandbox once it has
  // STARTED, nothing here ever held the box that was left in `build_failed`.
  // It had to be deleted by hand through the REST API.
  it('finds the box by the create id and deletes it', async () => {
    const rows = [listRow({ createId: CREATE_ID, errorReason: REAL_REASON })]
    const { list, asked } = lister(rows)
    const failed = await reapFailedCreate(list, CREATE_ID)
    expect(asked).toEqual([{ veris_create_id: CREATE_ID }])
    expect(rows[0]!.deletes).toBe(1)
    expect(failed).toEqual({
      id: 'dtn_1', state: 'build_failed', errorReason: REAL_REASON, deleted: true,
    })
  })

  it('refuses to delete a sandbox that does not carry the create id', async () => {
    // The one failure worse than the leak. An ATTACHED twin can have several
    // sandboxes on it, so nothing about the twin id identifies this create —
    // and a server-side filter that came back wider than it was asked for
    // would otherwise delete a box somebody else is still using.
    const rows = [listRow({ id: 'someone_elses', createId: 'other-create' })]
    const { list } = lister(rows)
    expect(await reapFailedCreate(list, CREATE_ID)).toBeUndefined()
    expect(rows[0]!.deletes).toBe(0)
  })

  it('reads the record again when the list row carries no reason', async () => {
    const rows = [listRow({ createId: CREATE_ID, onRefresh: { errorReason: REAL_REASON } })]
    const { list } = lister(rows)
    const failed = await reapFailedCreate(list, CREATE_ID)
    expect(rows[0]!.refreshes).toBe(1)
    expect(failed?.errorReason).toBe(REAL_REASON)
  })

  it('does not spend the extra fetch when the row already has the reason', async () => {
    const rows = [listRow({ createId: CREATE_ID, errorReason: REAL_REASON })]
    await reapFailedCreate(lister(rows).list, CREATE_ID)
    expect(rows[0]!.refreshes).toBe(0)
  })

  it('reports a delete that did not go through rather than claiming it did', async () => {
    const rows = [listRow({ createId: CREATE_ID, errorReason: REAL_REASON, deleteFails: true })]
    const failed = await reapFailedCreate(lister(rows).list, CREATE_ID)
    expect(failed?.deleted).toBe(false)
  })

  it('says nothing when Daytona made nothing', async () => {
    expect(await reapFailedCreate(lister([]).list, CREATE_ID)).toBeUndefined()
  })

  it('swallows a list that cannot be read, so the create`s own error stands', async () => {
    const list = () => (async function* () { throw new Error('502'); yield listRow() })()
    expect(await reapFailedCreate(list, CREATE_ID)).toBeUndefined()
  })
})

describe('sandboxCreateMessage carries the reason Daytona supplied', () => {
  // The regression: the package printed "Daytona sandbox create failed: Sandbox
  // 7ba4… failed to start with status: build_failed, error reason: null" while
  // Daytona's own record for that sandbox said "pull access denied, repository
  // does not exist". The one thing a first-time user needs was the one thing
  // dropped — the SDK renders the reason off a Sandbox object the event stream
  // never fills in.
  const failed = {
    id: 'dtn_1', state: 'build_failed', errorReason: REAL_REASON, deleted: true,
  }

  it('leads with the reason, not with the null', () => {
    const msg = sandboxCreateMessage(SDK_ERROR, failed, { image: 'studioops-api-test' })
    expect(msg).toContain('pull access denied')
    expect(msg.indexOf('pull access denied')).toBeLessThan(msg.indexOf('error reason: null'))
  })

  it('says the image is Daytona`s to resolve, not the local Docker daemon`s', () => {
    const msg = sandboxCreateMessage(SDK_ERROR, failed, { image: 'studioops-api-test' })
    expect(msg).toContain('Daytona builds "studioops-api-test" on its own servers')
    expect(msg).toContain('local Docker daemon')
  })

  it('leaves the image sentence off when the image is not what failed', () => {
    const started = { ...failed, state: 'error' }
    expect(sandboxCreateMessage(SDK_ERROR, started, { image: 'python:3.12' }))
      .not.toContain('local Docker daemon')
    // A snapshot create has no image to name at all.
    expect(sandboxCreateMessage(SDK_ERROR, failed, { snapshot: 'snap_1' } as { image?: unknown }))
      .not.toContain('local Docker daemon')
  })

  it('says the leaked box is gone, and names it either way', () => {
    expect(sandboxCreateMessage(SDK_ERROR, failed)).toContain('The half-built sandbox dtn_1 was deleted')
    const kept = sandboxCreateMessage(SDK_ERROR, { ...failed, deleted: false })
    expect(kept).toContain('could not be deleted')
    expect(kept).toContain('veris-daytona teardown dtn_1')
  })

  it('is the bare message when Daytona made nothing to report on', () => {
    // Unchanged behaviour for the failures that never reach Daytona — an
    // invalid key, a gateway that was not offered. VerisError folds the cause in.
    expect(sandboxCreateMessage(SDK_ERROR, undefined)).toBe('Daytona sandbox create failed')
  })

  it('folds the SDK`s own line in once, rather than letting VerisError repeat it', () => {
    const msg = sandboxCreateMessage(SDK_ERROR, failed, { image: 'studioops-api-test' })
    const e = new VerisError(msg, { phase: 'sandbox-create', cause: SDK_ERROR })
    expect(e.message).toBe(msg)
    expect(e.message.split('failed to start with status').length - 1).toBe(1)
    expect(e.cause).toBe(SDK_ERROR)
  })
})

/**
 * The two fixes as create() actually runs them: the control plane answered over
 * a stubbed fetch, Daytona's own create and list stubbed on the base prototype.
 */
describe('create() cleans up after a build that failed', () => {
  const twin = {
    id: 'sbx_1',
    environment_id: 'env_1',
    status: 'ready',
    services: [{
      name: 'stripe', status: 'ready',
      url: 'https://twin.test/stripe', control_url: 'https://twin.test/stripe',
      routes: [{ host: 'api.stripe.com' }],
    }],
  }

  function controlPlane() {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = String(url)
      calls.push(`${init.method ?? 'GET'} ${u}`)
      const body =
        u.includes('/egress-credential') ? {
          socks_address: 'gw.test:1080', connect_address: 'gw.test:8443',
          http_proxy_url: 'http://u:p@gw.test:8443',
          username: 'u', password: 'p', ca_pem: 'PEM', canary_host: 'canary.test',
        }
        : u.includes('/veris/requests') ? { requests: [] }
        : twin
      return { ok: true, status: 200, async text() { return JSON.stringify(body) }, async json() { return body } } as Response
    }))
    return calls
  }

  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

  it('deletes the leaked sandbox and names the reason Daytona recorded', async () => {
    const calls = controlPlane()
    const leaked = listRow({ errorReason: REAL_REASON })
    let stamped: Record<string, string> = {}

    vi.spyOn(BaseDaytona.prototype, 'create').mockImplementation(async (params?: unknown) => {
      stamped = (params as { labels?: Record<string, string> })?.labels ?? {}
      // The sandbox exists in Daytona by now; the SDK just never hands it over.
      leaked.labels = { veris_create_id: stamped.veris_create_id! }
      throw SDK_ERROR
    })
    vi.spyOn(BaseDaytona.prototype, 'list').mockImplementation((query?: { labels?: Record<string, string> }) =>
      (async function* () {
        if (query?.labels?.veris_create_id === leaked.labels.veris_create_id) yield leaked
      })() as never)

    const daytona = new Daytona({
      apiKey: 'dtn_key', useDeprecatedPolling: true,
      veris: { apiKey: 'veris_key', environmentId: 'env_1', apiBase: 'https://api.veris.test' },
    })
    const err = await daytona.create({ image: 'studioops-api-test' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(VerisError)
    expect((err as VerisError).message).toContain('pull access denied')
    expect((err as VerisError).message).toContain('local Docker daemon')
    expect((err as VerisError).message).toContain('The half-built sandbox dtn_1 was deleted')
    expect(leaked.deletes).toBe(1)
    // And the twin still goes with it — the rule that was already here.
    expect(calls).toContain('DELETE https://api.veris.test/v1/environments/env_1/sandboxes/sbx_1')
  })

  it('leaves an attached twin alone, and still reaps the sandbox', async () => {
    const calls = controlPlane()
    const leaked = listRow({ errorReason: REAL_REASON })
    vi.spyOn(BaseDaytona.prototype, 'create').mockImplementation(async (params?: unknown) => {
      leaked.labels = { veris_create_id: (params as { labels: Record<string, string> }).labels.veris_create_id! }
      throw SDK_ERROR
    })
    vi.spyOn(BaseDaytona.prototype, 'list').mockImplementation(() =>
      (async function* () { yield leaked })() as never)

    const daytona = new Daytona({ apiKey: 'dtn_key', useDeprecatedPolling: true })
    await daytona.create({
      image: 'studioops-api-test',
      veris: { apiKey: 'veris_key', apiBase: 'https://api.veris.test', attachSandboxId: 'sbx_1' },
    } as Parameters<Daytona['create']>[0]).catch(() => {})

    expect(leaked.deletes).toBe(1)
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false)
  })

  it('does not go looking when Daytona was never asked', async () => {
    controlPlane()
    vi.stubEnv('VERIS_ENVIRONMENT_ID', '')
    const list = vi.spyOn(BaseDaytona.prototype, 'list')
    const daytona = new Daytona({ apiKey: 'dtn_key', useDeprecatedPolling: true })
    // No environment and no twin to attach to: this fails before any request.
    const err = await daytona.create({
      image: 'python:3.12', veris: { apiKey: 'veris_key', apiBase: 'https://api.veris.test' },
    } as Parameters<Daytona['create']>[0]).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/no Veris environment/)
    expect(list).not.toHaveBeenCalled()
  })
})
