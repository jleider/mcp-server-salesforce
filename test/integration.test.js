import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const TEST_PORT = 3999;
const SERVER_URL = `http://127.0.0.1:${TEST_PORT}`;

describe('MCP Server Integration Tests', () => {
  let serverProcess = null;

  before(async () => {
    // Start the HTTP server
    console.log('Starting MCP HTTP server for integration tests...');
    serverProcess = spawn('node', ['dist/http-server.js'], {
      env: {
        ...process.env,
        MCP_HTTP_PORT: TEST_PORT.toString(),
        MCP_HTTP_HOST: '127.0.0.1',
        ALLOWED_HOSTS: `127.0.0.1:${TEST_PORT},localhost:${TEST_PORT}`,
        CORS_ORIGINS: '*'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.on('error', (err) => {
      console.error('Failed to start server:', err);
    });

    // Wait for server to start
    await sleep(2000);
    
    if (serverProcess.killed) {
      throw new Error('Server failed to start');
    }
  });

  after(() => {
    if (serverProcess && !serverProcess.killed) {
      console.log('Stopping MCP HTTP server...');
      serverProcess.kill('SIGTERM');
    }
  });

  describe('Health Check', () => {
    it('should return healthy status', async () => {
      const response = await fetch(`${SERVER_URL}/health`);
      assert.strictEqual(response.status, 200);
      
      const data = await response.json();
      assert.strictEqual(data.status, 'ok');
      assert.strictEqual(data.message, 'Salesforce MCP Server is running');
    });
  });

  describe('MCP Protocol', () => {
    it('should handle MCP initialization request', async () => {
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {
            roots: { listChanged: true }
          },
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      };

      const response = await fetch(`${SERVER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify(initRequest)
      });

      assert.strictEqual(response.status, 200);
      assert.ok(response.headers.get('mcp-session-id'));
      
      const text = await response.text();
      assert.ok(text.includes('event: message'));
      assert.ok(text.includes('salesforce-mcp-server'));
      assert.ok(text.includes('protocolVersion'));
    });

    it('should handle tools list request', async () => {
      // First initialize
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      };

      const initResponse = await fetch(`${SERVER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify(initRequest)
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      assert.ok(sessionId, 'Should receive session ID');

      // Then request tools list
      const toolsRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      };

      const toolsResponse = await fetch(`${SERVER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId
        },
        body: JSON.stringify(toolsRequest)
      });

      assert.strictEqual(toolsResponse.status, 200);
      
      const text = await toolsResponse.text();
      assert.ok(text.includes('event: message'));
      
      // Check that expected Salesforce tools are present
      assert.ok(text.includes('salesforce_search_objects'));
      assert.ok(text.includes('salesforce_describe_object'));
      assert.ok(text.includes('salesforce_query_records'));
    });

    it('should reject requests without proper Accept header', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      };

      const response = await fetch(`${SERVER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
          // Missing Accept header
        },
        body: JSON.stringify(request)
      });

      assert.strictEqual(response.status, 406);
      
      const data = await response.json();
      assert.ok(data.error);
      assert.ok(data.error.message.includes('Accept'));
    });

    it('should handle invalid JSON gracefully', async () => {
      const response = await fetch(`${SERVER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: 'invalid json'
      });

      assert.strictEqual(response.status, 400);
    });
  });

  describe('DNS Rebinding Protection', () => {
    it('should handle requests normally for allowed hosts', async () => {
      // Note: DNS rebinding protection is handled by the MCP SDK transport layer
      // This test verifies normal operation with allowed hosts
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      };

      const response = await fetch(`${SERVER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify(request)
      });

      assert.strictEqual(response.status, 200);
      assert.ok(response.headers.get('mcp-session-id'));
    });
  });

  describe('CORS Support', () => {
    it('should include CORS headers in responses', async () => {
      // Test with Origin header to trigger CORS headers
      const response = await fetch(`${SERVER_URL}/health`, {
        headers: {
          'Origin': 'http://localhost:3000'
        }
      });

      assert.strictEqual(response.status, 200);
      assert.ok(response.headers.get('access-control-expose-headers'));
      
      // Test OPTIONS request for CORS preflight
      const optionsResponse = await fetch(`${SERVER_URL}/health`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:3000'
        }
      });
      
      assert.strictEqual(optionsResponse.status, 204);
      assert.ok(optionsResponse.headers.get('access-control-allow-methods'));
      assert.ok(optionsResponse.headers.get('access-control-expose-headers'));
    });
  });

  describe('Session Management', () => {
    it('should maintain session state across requests', async () => {
      // Initialize session
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      };

      const initResponse = await fetch(`${SERVER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify(initRequest)
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      assert.ok(sessionId);

      // Make multiple requests with same session ID
      for (let i = 0; i < 3; i++) {
        const request = {
          jsonrpc: '2.0',
          id: i + 2,
          method: 'tools/list'
        };

        const response = await fetch(`${SERVER_URL}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'mcp-session-id': sessionId
          },
          body: JSON.stringify(request)
        });

        assert.strictEqual(response.status, 200);
      }
    });

    it('should handle session termination', async () => {
      // Initialize session
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      };

      const initResponse = await fetch(`${SERVER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify(initRequest)
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      assert.ok(sessionId);

      // Terminate session
      const deleteResponse = await fetch(`${SERVER_URL}/mcp`, {
        method: 'DELETE',
        headers: {
          'mcp-session-id': sessionId
        }
      });

      assert.strictEqual(deleteResponse.status, 200);

      // Try to use terminated session
      const request = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      };

      const failedResponse = await fetch(`${SERVER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'mcp-session-id': sessionId
        },
        body: JSON.stringify(request)
      });

      assert.strictEqual(failedResponse.status, 400);
    });
  });
});