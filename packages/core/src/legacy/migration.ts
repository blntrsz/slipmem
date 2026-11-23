/**
 * Legacy SQLite migration and read-only compatibility surface.
 *
 * Import these through `@slipmem/core/legacy/migration`. The Markdown model is
 * the active storage contract; keeping migration code behind an explicit
 * subpath makes its legacy status visible at every import site.
 */
export * from "../migration/legacy-read.js"
export * from "../migration/migration-import.js"
export * from "../migration/migration-plan.js"
