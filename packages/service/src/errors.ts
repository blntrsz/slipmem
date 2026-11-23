export type ServiceErrorCode =
  | "invalid-root"
  | "invalid-port"
  | "config"
  | "already-running"
  | "start-timeout"
  | "service-exited"
  | "identity-mismatch"
  | "stop-timeout"
  | "io"

/**
 * One lifecycle failure with a stable code. The CLI maps config/usage failures
 * to a usage error and operational failures to an unavailable result; the
 * message is already suitable for a human or an error envelope.
 */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode

  constructor(code: ServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ServiceError"
    this.code = code
  }
}
