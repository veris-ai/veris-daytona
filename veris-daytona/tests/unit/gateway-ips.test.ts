import { afterEach, describe, expect, it, vi } from 'vitest'

const resolve4 = vi.fn()
vi.mock('node:dns', () => ({ promises: { resolve4: (...a: unknown[]) => resolve4(...a) } }))

import { gatewayIps } from '../../src/gateway'

afterEach(() => resolve4.mockReset())

describe('gatewayIps', () => {
  it('takes the addresses the control plane published, and never resolves', async () => {
    expect(await gatewayIps({ gateway_ips: ['136.64.238.87'] }, 'http://u:p@gw.dev.api.veris.ai:8080'))
      .toEqual(['136.64.238.87'])
    expect(resolve4).not.toHaveBeenCalled()
  })

  it('resolves the proxy host once for a control plane that predates the field', async () => {
    resolve4.mockResolvedValueOnce(['203.0.113.9'])
    expect(await gatewayIps({}, 'http://u:p@gw.old.veris.ai:8080')).toEqual(['203.0.113.9'])
    expect(resolve4).toHaveBeenCalledWith('gw.old.veris.ai')
  })

  it('uses an IP-literal proxy host as it is', async () => {
    expect(await gatewayIps({ gateway_ips: [] }, 'http://u:p@203.0.113.9:8080')).toEqual(['203.0.113.9'])
    expect(resolve4).not.toHaveBeenCalled()
  })

  it('comes back empty when the lookup fails, so buildNetwork can say what to do', async () => {
    resolve4.mockRejectedValueOnce(new Error('ENOTFOUND'))
    expect(await gatewayIps({}, 'http://u:p@gw.nowhere.test:8080')).toEqual([])
  })
})
