import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { caBundleScript, refreshTrustAfterStart } from '../../src/ca-bundle'
import { Daytona } from '../../src/daytona'
import { Daytona as BaseDaytona } from '@daytona/sdk'
let dir: string
let paths: Parameters<typeof caBundleScript>[0]
const cert = (name: string) =>
  `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----\n`
const env = () => ({ PATH: process.env.PATH, SSL_CERT_FILE: paths!.provider })
const rebuild = () =>
  execFileSync('sh', ['-c', caBundleScript(paths)], { env: env() })
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veris-ca-test-'))
  paths = {
    system: join(dir, 'system'),
    provider: join(dir, "provider's bundle"),
    veris: join(dir, 'veris'),
    installedVeris: join(dir, 'installed'),
    output: join(dir, 'combined'),
  }
  writeFileSync(paths.system, cert('PUBLIC'))
  writeFileSync(paths.veris, cert('VERIS'))
  writeFileSync(paths.provider, cert('PROVIDER-A'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})
it('merges separately mounted provider certificates without losing public or Veris trust', () => {
  rebuild()
  const bundle = readFileSync(paths!.output, 'utf8')
  expect(bundle).toBe(cert('PUBLIC') + cert('PROVIDER-A') + cert('VERIS'))
  expect(readFileSync(paths!.provider, 'utf8')).toBe(cert('PROVIDER-A'))
})
it('replaces rotated provider roots instead of accumulating the old generated bundle', () => {
  rebuild()
  writeFileSync(paths!.provider, cert('PROVIDER-B'))
  rebuild()
  const bundle = readFileSync(paths!.output, 'utf8')
  expect(bundle).toContain('PROVIDER-B')
  expect(bundle).not.toContain('PROVIDER-A')
})
it('does not replace identical output and can recreate a missing bundle from installed Veris material', () => {
  rebuild()
  const inode = statSync(paths!.output).ino
  rebuild()
  expect(statSync(paths!.output).ino).toBe(inode)
  writeFileSync(paths!.installedVeris, readFileSync(paths!.veris))
  rmSync(paths!.veris)
  rmSync(paths!.output)
  rebuild()
  expect(readFileSync(paths!.output, 'utf8')).toContain('VERIS')
})
it('leaves the previous bundle intact when Veris material is missing', () => {
  rebuild()
  const before = readFileSync(paths!.output)
  rmSync(paths!.veris)
  expect(() => rebuild()).toThrow()
  expect(readFileSync(paths!.output)).toEqual(before)
})
it('verifies a new signer only after refresh with real certificate chains', () => {
  for (const name of ['A', 'B']) {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${name}`,
        '-keyout',
        join(dir, name + '.key'),
        '-out',
        join(dir, name + '.pem'),
      ],
      { stdio: 'ignore' },
    )
  }
  writeFileSync(paths!.provider, readFileSync(join(dir, 'A.pem')))
  writeFileSync(paths!.system, '')
  writeFileSync(paths!.veris, readFileSync(join(dir, 'A.pem')))
  rebuild()
  const verify = () =>
    spawnSync(
      'openssl',
      ['verify', '-CAfile', paths!.output, join(dir, 'B.pem')],
      { encoding: 'utf8' },
    ).status
  expect(verify()).not.toBe(0)
  writeFileSync(paths!.provider, readFileSync(join(dir, 'B.pem')))
  rebuild()
  expect(verify()).toBe(0)
}, 30000)
function sandbox() {
  return {
    id: 'box',
    state: 'started',
    labels: {
      veris_twin_id: 'twin',
      veris_env_id: 'env',
      veris_api_base: 'https://example.invalid',
    },
    start: vi.fn(async (_timeout?: number) => {}),
    recover: vi.fn(async () => {}),
    delete: vi.fn(),
    process: {
      executeCommand: vi.fn(async () => ({
        exitCode: 0,
        result: '__VERIS_CA_OK__',
      })),
    },
  }
}
it('refreshes only after start/recover succeeds and preserves timeout arguments', async () => {
  const box = sandbox()
  const start = box.start
  refreshTrustAfterStart(box as never)
  await box.start(42)
  expect(start).toHaveBeenCalledWith(42)
  expect(box.process.executeCommand).toHaveBeenCalledOnce()
  await box.recover()
  expect(box.process.executeCommand).toHaveBeenCalledTimes(2)
  start.mockRejectedValueOnce(new Error('start failed'))
  await expect(box.start()).rejects.toThrow('start failed')
  expect(box.process.executeCommand).toHaveBeenCalledTimes(2)
})
it('propagates refresh failure instead of handing back a successful start', async () => {
  const box = sandbox()
  refreshTrustAfterStart(box as never)
  box.process.executeCommand.mockResolvedValue({ exitCode: 1, result: '' })
  await expect(box.start()).rejects.toThrow('could not refresh')
})
it('refreshes a running get, defers a stopped get to start, and leaves ordinary boxes alone', async () => {
  const box = sandbox()
  vi.spyOn(BaseDaytona.prototype, 'get').mockResolvedValue(box as never)
  const client = new Daytona({
    apiKey: 'dummy',
    veris: { apiKey: 'dummy', apiBase: 'https://example.invalid' },
  })
  await client.get('box')
  expect(box.process.executeCommand).toHaveBeenCalledOnce()
  const stopped = sandbox()
  stopped.state = 'stopped'
  vi.mocked(BaseDaytona.prototype.get).mockResolvedValue(stopped as never)
  await client.get('box')
  expect(stopped.process.executeCommand).not.toHaveBeenCalled()
  await stopped.start()
  expect(stopped.process.executeCommand).toHaveBeenCalledOnce()
  const plain = sandbox()
  plain.labels = {} as never
  vi.mocked(BaseDaytona.prototype.get).mockResolvedValue(plain as never)
  await client.get('box')
  expect(plain.process.executeCommand).not.toHaveBeenCalled()
})
