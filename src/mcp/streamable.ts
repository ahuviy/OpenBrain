/**
 * Stateless Streamable HTTP transport for the MCP server.
 *
 * Each authorized POST /mcp gets a fresh Server + transport, so there is no
 * session state to pin to a pod (unlike the legacy SSE transport, which needed
 * sticky sessions). The transport reads the request body itself, so callers
 * must NOT body-parse /mcp upstream.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { createMcpServer } from "./server.js";

export async function handleStreamableRequest(
  req: IncomingMessage & { auth?: AuthInfo },
  res: ServerResponse
): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}
