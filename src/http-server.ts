#!/usr/bin/env node

import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import * as dotenv from "dotenv";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createSalesforceServer } from "./server-factory.js";

dotenv.config();

const app = express();

// JSON parsing middleware with error handling
app.use(express.json({
  // Add error handling for malformed JSON
  type: 'application/json',
  limit: '1mb'
}));

// JSON parse error handling middleware
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32700,
        message: 'Parse error: Invalid JSON',
      },
      id: null,
    });
  }
  next();
});

// CORS configuration for browser-based clients
app.use(cors({
  origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : '*',
  exposedHeaders: ['Mcp-Session-Id'],
  allowedHeaders: ['Content-Type', 'mcp-session-id', 'Accept', 'Host'],
  credentials: false,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  // Always send the access-control-allow-origin header
  optionsSuccessStatus: 204
}));

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ${req.method} ${req.path} - ${req.get('User-Agent') || 'Unknown'}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Salesforce MCP Server is running' });
});

// Handle POST requests for client-to-server communication
app.post('/mcp', async (req, res) => {
  try {
    // Check Accept header
    const accept = req.headers.accept;
    if (!accept || (!accept.includes('application/json') && !accept.includes('text/event-stream'))) {
      res.status(406).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Not Acceptable: Accept header must include application/json or text/event-stream',
        },
        id: null,
      });
      return;
    }
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    console.error(`[MCP POST] Session ID: ${sessionId || 'new'}, Method: ${req.body?.method || 'unknown'}`);
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          // Store the transport by session ID
          transports[sessionId] = transport;
          console.error(`[SESSION] Initialized: ${sessionId}`);
        },
        onsessionclosed: (sessionId) => {
          console.error(`[SESSION] Closed: ${sessionId}`);
        },
        // Enable DNS rebinding protection for security
        enableDnsRebindingProtection: true,
        allowedHosts: process.env.ALLOWED_HOSTS ? process.env.ALLOWED_HOSTS.split(',') : ['127.0.0.1', 'localhost'],
        allowedOrigins: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : undefined,
      });

      // Clean up transport when closed
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          console.error(`[TRANSPORT] Closed for session: ${transport.sessionId}`);
        }
      };

      // Create and connect server
      const server = createSalesforceServer();
      await server.connect(transport);
    } else {
      // Invalid request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP POST request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (req: express.Request, res: express.Response) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Invalid or missing session ID',
        },
        id: null,
      });
      return;
    }
    
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling session request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
};

// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', handleSessionRequest);

// Handle DELETE requests for session termination
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports[sessionId]) {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
    // Clean up after handling the delete request
    delete transports[sessionId];
  } else {
    await handleSessionRequest(req, res);
  }
});

// Error handling middleware
app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', error);
  if (!res.headersSent) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error',
      },
      id: null,
    });
  }
});

// Start the HTTP server
const PORT = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT) : 3000;
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.error(`Salesforce MCP Server running on HTTP at http://${HOST}:${PORT}`);
  console.error(`Health check available at http://${HOST}:${PORT}/health`);
  console.error(`MCP endpoint available at http://${HOST}:${PORT}/mcp`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.error('[SERVER] Shutting down MCP HTTP server...');
  // Clean up all active transports
  Object.keys(transports).forEach(sessionId => {
    const transport = transports[sessionId];
    transport.close?.();
    delete transports[sessionId];
  });
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('[SERVER] Received SIGTERM, shutting down MCP HTTP server...');
  // Clean up all active transports
  Object.keys(transports).forEach(sessionId => {
    const transport = transports[sessionId];
    transport.close?.();
    delete transports[sessionId];
  });
  process.exit(0);
});