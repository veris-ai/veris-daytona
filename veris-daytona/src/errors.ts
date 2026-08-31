/**
 * Every failure phase a Veris error can name. Bring-up spans four systems
 * (control plane, Daytona API, the sandbox, the Veris gateway), so errors
 * carry a structured phase rather than a wall of logs.
 */
export type VerisErrorPhase =
  | 'credentials'
  | 'twin-provision'
  | 'gateway-preflight'
  | 'credential-mint'
  | 'sandbox-create'
  | 'ca-install'
  | 'canary'
  | 'receipt'
  | 'twin-state'
  | 'attach'

/**
 * Base class for every error this package throws. Deliberately NOT a subclass
 * of any Daytona error: `e instanceof VerisError` cleanly separates Veris
 * failures from Daytona failures in one catch.
 */
/**
 * Fold the wrapped error's own message into ours.
 *
 * `cause` is preserved either way, but almost nothing that shows an error to a
 * human walks the cause chain -- OpenCode prints `err.message` and stops. So
 * "Daytona sandbox create failed" was all anyone saw for what was really
 * "Invalid credentials": a message that says a thing went wrong and refuses to
 * say why, which is the most expensive kind of error to be handed.
 */
function withCause(message: string, cause: unknown): string {
  const detail =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  // Already said, or nothing to add.
  if (!detail || message.includes(detail)) return message
  const trimmed = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail
  return `${message}: ${trimmed}`
}

export class VerisError extends Error {
  readonly phase?: VerisErrorPhase
  /** The Veris twin's sandbox id, when one exists yet. */
  readonly verisSandboxId?: string
  /** Verbatim control-plane response body, when the failure came from an API call. */
  readonly responseBody?: unknown

  constructor(
    message: string,
    opts: { phase?: VerisErrorPhase; verisSandboxId?: string; responseBody?: unknown; cause?: unknown } = {},
  ) {
    super(withCause(message, opts.cause), opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = new.target.name
    this.phase = opts.phase
    this.verisSandboxId = opts.verisSandboxId
    this.responseBody = opts.responseBody
  }
}

/** A required credential/coordinate is missing. Thrown before any network call, naming the exact variable. */
export class MissingCredentialsError extends VerisError {}

/** The Veris gateway infrastructure is down (control-plane health said so). */
export class VerisGatewayUnreachableError extends VerisError {}

/** The control plane does not offer gateway mode (endpoint absent, or this SDK version is below min_sdk). */
export class VerisGatewayNotOfferedError extends VerisError {
  /** Server-announced minimum SDK version, when the refusal carried one. */
  readonly minSdk?: string
  constructor(message: string, opts: ConstructorParameters<typeof VerisError>[1] & { minSdk?: string } = {}) {
    super(message, opts)
    this.minSdk = opts.minSdk
  }
}

/** The canary probe failed: egress is not (or no longer) reaching the twin. */
export class ReceiptIntegrityError extends VerisError {}

/** assertTouched(): the named service saw zero intercepted requests — green without the receipt. */
export class VerisUntouchedError extends VerisError {
  readonly service: string
  constructor(message: string, service: string, opts: ConstructorParameters<typeof VerisError>[1] = {}) {
    super(message, opts)
    this.service = service
  }
}

/** The Daytona sandbox is alive but its Veris twin is gone (TTL expiry, delete, reset). */
export class TwinExpiredError extends VerisError {}

/** The sandbox image cannot host the Veris layer — in practice, no
 *  ca-certificates, so the gateway CA cannot be trusted. */
export class SnapshotUnsupportedError extends VerisError {}

/** An inherited Daytona operation that would break the one-sandbox-one-twin invariant (e.g. fork). */
export class UnsupportedOperationError extends VerisError {}
