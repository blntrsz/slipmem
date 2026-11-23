/**
 * Compatibility surface for callers that imported the memory runtime from
 * `@slipmem/mcp`.
 *
 * The shared provider resolution, raw-write signal, note watcher, durable
 * receipts, worker lifecycle, and run lease now live in `@slipmem/core/runtime`.
 * This module only re-exports those symbols so existing imports keep working;
 * no shared behavior is owned here.
 */
export {
  DEFAULT_RECALL_JEV_MODEL,
  DEFAULT_RUN_LEASE_POLL_MS,
  DEFAULT_RUN_LEASE_STALE_MS,
  formatAutomaticMemoryNotice,
  makeAutomaticMemoryLayer,
  makeMaintenanceLayer,
  makeMaintenanceWorkerLayer,
  makeRawWriteRepositoryLayer,
  makeRawWriteSignalLayer,
  PRIMARY_CHAT_ENV_NAMES,
  RawWriteSignal,
  REVISION_RECEIPT_FILENAME,
  resolveAutomaticMemoryRuntime,
  resolvePrimaryChatModel,
  resolveRecallProvider,
  RUN_LEASE_FILENAME,
  startNoteWatch,
  withRunLease,
  type AutomaticMemoryEgress,
  type AutomaticMemoryProvider,
  type AutomaticMemoryRuntime,
  type PrimaryChatModel,
  type RawWriteSignalShape,
  type RecallProviderRuntime,
} from "@slipmem/core/runtime"
