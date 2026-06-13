#!/usr/bin/env node

import { startStdioTransport } from "../app/mcp";
import { successResponse } from "../app/mcp/protocol";

startStdioTransport(async (message) => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const id = typeof message.id === "string" || typeof message.id === "number" || message.id === null
    ? message.id
    : null;
  return successResponse(id, { ok: true });
});
