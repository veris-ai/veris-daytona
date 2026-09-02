// @veris-ai/daytona — Veris twin interception for Daytona sandboxes.
//
// This is the ENGINE integration, and it is deliberately generic: it knows
// nothing about what you run in the sandbox, and needs no particular image.
// Running an agent in there is one use of it (see @veris-ai/daytona-opencode)
// rather than what it is for — the same relationship @veris-ai/e2b has to E2B.
//
// A drop-in for @daytona/sdk. The only difference is that `Daytona` is ours,
// so every sandbox it creates comes up with a Veris twin already answering its
// vendor API calls:
//
//   import { Daytona } from '@veris-ai/daytona'   // was '@daytona/sdk'
//   const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
//   const sbx = await daytona.create()
//   await sbx.process.executeCommand('curl https://api.stripe.com/v1/charges')
//   await sbx.veris.assertTouched('stripe')
//   await sbx.delete()                            // deletes the twin too
//
// Everything else from @daytona/sdk is re-exported unchanged, so apps depend
// only on this package.
//
// @daytona/sdk is a PEER dependency, deliberately. Consumers do
// `err instanceof DaytonaNotFoundError` on errors that cross this boundary
// (the OpenCode plugin branches on exactly that to tell "sandbox is gone" from
// "transient failure"), and two copies of the SDK in one tree would make those
// checks silently return false.
export * from '@daytona/sdk'

// Ours wins the name. An explicit local export takes precedence over the star
// above, which is the whole trick that makes the plugin fork a one-line diff.
export { Daytona, default } from './daytona'
export type { VerisOpts, VerisDaytonaConfig, VerisSandbox } from './daytona'
export { isVerisSandbox } from './daytona'

export type { VerisApi, TouchMatcher, DeliverToOpts, VerisContext } from './veris-api'
export type { Receipt, ReceiptEntry, ReceiptRequest, ReceiptLeak } from './receipt'
export type { EgressMode, NetworkParams } from './network'
export { DEFAULT_REGISTRY_HOSTS, vendorHosts, twinHosts, dataPlaneHosts } from './network'
export type { ServiceInfo as VerisServiceInfo, RouteEntry, TwinSandbox } from './control-plane'
export { ControlPlane } from './control-plane'
export { CA_CERT_PATH, SYSTEM_BUNDLE, VERIS_BUNDLE, VERIS_CA_FILE, NODE_TRUST_APPEND_CMD, vendoredTrustEnv } from './trust'
export { gatewayProxyUrl } from './gateway'
export { fetchManual, assertHttpControlPlane } from './state'
export {
  VerisError,
  MissingCredentialsError,
  VerisGatewayUnreachableError,
  VerisGatewayNotOfferedError,
  ReceiptIntegrityError,
  VerisUntouchedError,
  TwinExpiredError,
  SnapshotUnsupportedError,
  UnsupportedOperationError,
} from './errors'
export type { VerisErrorPhase } from './errors'
export { SDK_VERSION } from './version'
