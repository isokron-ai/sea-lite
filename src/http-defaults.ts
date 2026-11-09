/**
 * HTTP transport constants the CLI help needs without loading the transport
 * (src/http.ts pulls in the MCP SDK; it re-exports these).
 */

/** kronicle-lite's `serve --http` defaults to 7417; sea-lite takes the next port so both can run on one box. */
export const DEFAULT_HTTP_PORT = 7418;
