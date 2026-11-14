/**
 * The stdio MCP server and the web server share one SQLite file and therefore
 * must share its migration history. Re-exporting the server database layer
 * keeps the two transports from drifting to different schemas.
 */
export { makeDatabaseLayer } from "@slipmem/server"
