import type { ServiceState } from "./state"

const noStore = { "cache-control": "no-store" } as const

/**
 * The loopback health payload is the service's readiness contract. A listener
 * that is bound but whose application layer is still building answers
 * `not-ready`; one whose layer failed answers `startup-failed`. Only a service
 * with a written ready registration answers `ok`, so a health probe can never
 * certify a service whose API would fail every request.
 */
export const serviceHealthResponse = (
  state: ServiceState | undefined,
  readinessError: string | undefined,
): Response => {
  if (state !== undefined) {
    return Response.json(
      {
        ok: true,
        service: "slipmem",
        root: state.root,
        pid: state.pid,
        instanceId: state.instanceId,
        startedAt: state.startedAt,
        url: state.url,
      },
      { headers: noStore },
    )
  }

  if (readinessError !== undefined) {
    return Response.json(
      {
        ok: false,
        service: "slipmem",
        error: "startup-failed",
        message: readinessError,
      },
      { status: 503, headers: noStore },
    )
  }

  return Response.json(
    { ok: false, service: "slipmem", error: "not-ready" },
    { status: 503, headers: noStore },
  )
}
