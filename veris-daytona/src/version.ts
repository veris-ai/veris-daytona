// The SDK version sent to the control plane as X-Veris-SDK (it version-gates
// gateway mode on it). Injected from package.json at build time by tsup's
// `define`; the fallback keeps `tsx`/vitest runs working from source.
declare const __SDK_VERSION__: string | undefined

export const SDK_VERSION: string =
  typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0-dev'
