import { describe, expect, it } from 'vitest'
import {
  SNAPSHOT_ENTRYPOINT,
  SNAPSHOT_IMAGE,
  SNAPSHOT_IMAGE_VERSION,
  SNAPSHOT_NAME,
} from '../../src/snapshot'
import { parseRequestsBody } from '../../src/receipt'
import { proxyServeFlags } from '../../src/proxy'

const entrypoint = SNAPSHOT_ENTRYPOINT.join(' ')
const flags = proxyServeFlags('twin-abc', 'transparent')

describe('the snapshot entrypoint', () => {
  it('carries NO proxy flags, so the image survives a command-line change', () => {
    // A registered snapshot's entrypoint is immutable. Baking flags in means a
    // stale snapshot silently runs the OLD command line while the code believes
    // it changed — which is exactly how a --listen change went unnoticed.
    expect(entrypoint).not.toContain('veris-proxy')
    expect(entrypoint).not.toContain('--listen')
  })

  it('still prepares the run directory for the uid the proxy drops to', () => {
    expect(entrypoint).toContain('/run/veris/ca')
    expect(entrypoint).toContain('14741')
  })
})

describe('the veris-proxy command line', () => {
  it('passes --strict', () => {
    // Without it, `serve` lets unmapped hosts reach their REAL destination and
    // the product's claim collapses from "nothing reached the vendor" to "the
    // hosts we happened to map were intercepted". Nothing else in the system
    // catches its absence, so it is pinned here.
    expect(flags).toContain('--strict')
  })

  it('attaches to the twin the host provisioned, and never deploys its own', () => {
    // `serve --environment` would make the in-sandbox proxy the twin's OWNER,
    // so the host would never learn the twin id: receipt() would have nothing
    // to query and delete() nothing to tear down, leaking a twin per session
    // until its TTL reaped it.
    expect(flags).toContain("--sandbox 'twin-abc'")
    expect(flags).not.toContain('--environment')
  })

  it('writes a ready file and an env file', () => {
    // Readiness is what lets create() promise that the first tool call of a
    // session cannot outrun interception; the env file is where the integrity
    // probe reads VERIS_CANARY from, rather than a command line `ps` can read.
    expect(flags).toContain('--ready-file /run/veris/ready')
    expect(flags).toContain('--write-env /run/veris/env')
    // Writable by the uid the proxy drops to; the $HOME default is not.
    expect(flags).toContain('--ca-dir /run/veris/ca')
  })

  it('asks for the transparent tier', () => {
    expect(flags).toContain('--transparent')
  })
})

describe('the default snapshot', () => {
  it('carries the image version in its name, so an upgrade re-registers', () => {
    // Snapshots are org-scoped and immutable once built; a fixed name would
    // pin every org to whatever image they first registered.
    expect(SNAPSHOT_NAME).toContain(SNAPSHOT_IMAGE_VERSION)
  })

  it('is the GENERIC sandbox image, with no toolchain and no agent', () => {
    // @veris-ai/daytona is the Veris integration for Daytona, the same way
    // @veris-ai/e2b is for E2B. Defaulting to an OpenCode image would hand a
    // caller running a Python suite a Node install and an agent CLI they never
    // asked for. OpenCode is one consumer, set via VERIS_SNAPSHOT_IMAGE by
    // @veris-ai/daytona-opencode — it is not the default.
    expect(SNAPSHOT_IMAGE).toBe('ghcr.io/veris-ai/veris-sandbox')
    expect(SNAPSHOT_IMAGE).not.toContain('opencode')
    expect(SNAPSHOT_NAME).not.toContain('opencode')
  })
})

describe('parseRequestsBody', () => {
  it('reads a real trace log', () => {
    expect(parseRequestsBody({ requests: [{ method: 'POST', path: '/v1/charges', status: 200 }] }))
      .toEqual({ count: 1, entries: [{ method: 'POST', path: '/v1/charges', status: 200 }] })
  })

  it('treats a hung fault (no response) as a null status, not a missing request', () => {
    const { entries } = parseRequestsBody({ requests: [{ method: 'GET', path: '/v1/x' }] })
    expect(entries[0]!.status).toBeNull()
  })

  it('returns an empty receipt rather than throwing on junk', () => {
    for (const body of [undefined, null, {}, { requests: 'nope' }, 42]) {
      expect(parseRequestsBody(body)).toEqual({ count: 0, entries: [] })
    }
  })
})
