FROM node:22-alpine

# Set working directory
WORKDIR /app

# Install git for cloning repository
RUN apk add --no-cache git

# Clone the repository from the streamable-http branch
RUN git clone -b streamable-http https://github.com/jleider/mcp-server-salesforce.git /tmp/repo && \
    cp -r /tmp/repo/* /app/ && \
    rm -rf /tmp/repo

# Install dependencies and build
RUN npm install --ignore-scripts && npm run build

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S mcpserver -u 1001

# Change ownership of the app directory
RUN chown -R mcpserver:nodejs /app
USER mcpserver

# Expose the default HTTP port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); const options = { hostname: '127.0.0.1', port: process.env.MCP_HTTP_PORT || 3000, path: '/health', timeout: 2000 }; const req = http.request(options, (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); req.on('error', () => process.exit(1)); req.end();"

# Set default environment variables
ENV NODE_ENV=production
ENV MCP_HTTP_PORT=3000
ENV MCP_HTTP_HOST=0.0.0.0
ENV ALLOWED_HOSTS=127.0.0.1:3000,localhost:3000,127.0.0.1,localhost
ENV CORS_ORIGINS=*

# Start the HTTP server
CMD ["node", "dist/http-server.js"]