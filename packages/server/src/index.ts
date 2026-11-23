export { makeApiHandler, makeAppLayer, type ApiHandlerOptions, type AppLayerOptions } from "./app"
export { ApiError, NoteDraft } from "./api"
export { makeMarkdownLayer, toApiNote, type ApiNote, type MarkdownLayerOptions } from "./markdown"
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  isLoopbackHost,
  nonLoopbackWarning,
  resolveBindConfig,
  resolveDatabasePath,
  resolveNoteRootPath,
  type BindConfig,
  type NoteRootPathOptions,
} from "./config"
export {
  makeMcpHttp,
  mcpInstructions,
  mcpServerName,
  mcpServerVersion,
} from "./mcp"
export {
  formatAutomaticMemoryNotice,
  PRIMARY_CHAT_ENV_NAMES,
  resolveAutomaticMemoryRuntime,
  resolvePrimaryChatModel,
  resolveRecallProvider,
  type AutomaticMemoryRuntime,
  type PrimaryChatModel,
  type RecallProviderRuntime,
} from "@slipmem/mcp"
export {
  formatGitIngressNotice,
  GIT_INGRESS_ENV,
  GIT_INGRESS_PATH,
  makeGitIngressHandler,
  makeGitIngressLayer,
  resolveGitIngressConfig,
  type GitIngressConfig,
  type GitIngressEnabled,
  type GitIngressOptions,
  type GitIngressRunInput,
  type GitIngressRunResult,
  type GitIngressRunner,
} from "./git-ingress"
export { makeDatabaseLayer } from "./database"
export {
  makeMigrationsLayer,
  MigrationError,
  resolveMigrationsFolder,
  runMigrations,
} from "./migrations"
