#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as dotenv from "dotenv";
import { createSalesforceServer } from "./server-factory.js";

dotenv.config();

async function runServer() {
  const server = createSalesforceServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Salesforce MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});