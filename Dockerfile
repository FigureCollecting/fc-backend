# Multi-stage Dockerfile for Figure Collector Backend
# Supports base, development, test, builder, and production stages

# ============================================================================
# Base Stage - Common foundation for all stages
# ============================================================================
FROM node:26.8.1-alpine AS base

# Cache-bust ARG to invalidate Docker layers when security patches are needed
ARG CACHE_BUST=2026-09-01-npm-11.19.1-tar-fix

WORKDIR /app

# Upgrade all Alpine packages for latest security patches (openssl >= 3.5.8-r0, busybox, etc.)
# Pin npm EXACTLY at 11.19.1: bundles tar 7.5.22 (GHSA-r292-9mhp-454m fixed >=7.5.21)
# and brace-expansion 5.0.9; node 26.8.1's own bundled npm 11.19.0 and npm@12/latest
# ship vulnerable tar <=7.5.20. A floating `npm@11` can resolve to a stale/lagging
# version and silently revert the fix — pin exactly (fc-frontend precedent).
RUN apk update && \
    apk upgrade --no-cache && \
    apk add --no-cache dumb-init && \
    npm install -g npm@11.19.1 && \
    npm cache clean --force

# Copy package files (.npmrc maps @figurecollecting to GitHub Packages; it carries
# only a ${NODE_AUTH_TOKEN} placeholder, never a real token)
COPY package*.json .npmrc ./

# ============================================================================
# Development Stage - For local development with hot reload
# ============================================================================
FROM base AS development

# Install all dependencies (including dev dependencies).
# Token is provided via a BuildKit secret mount — exposed only for this RUN,
# never written to a layer or visible in `docker history`.
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)" npm ci

# Copy source code
COPY . .

# Expose port
EXPOSE 5080

# Use dumb-init and nodemon for development
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "dev"]

# ============================================================================
# Test Stage - For running tests
# ============================================================================
FROM base AS test

# Install all dependencies (including dev dependencies for testing)
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)" npm ci

# Copy source code
COPY . .

# Run tests
CMD ["npm", "test"]

# ============================================================================
# Builder Stage - Compiles TypeScript to JavaScript
# ============================================================================
FROM base AS builder

# Install all dependencies (including dev for building)
# Using --ignore-scripts for security to prevent execution of npm scripts
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)" npm ci --ignore-scripts

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# ============================================================================
# Production Stage - Optimized runtime image
# ============================================================================
FROM node:26.8.1-alpine AS production

# Cache-bust ARG for production stage security patches
ARG CACHE_BUST=2026-09-01-npm-11.19.1-tar-fix

# Build arguments for customization
ARG GITHUB_ORG=FigureCollecting
ARG GITHUB_REPO=fc-backend

# Add labels for better tracking
LABEL org.opencontainers.image.title="Figure Collector Backend"
LABEL org.opencontainers.image.description="Backend API service for Figure Collector"
LABEL org.opencontainers.image.vendor="Figure Collector Services"
LABEL org.opencontainers.image.source="https://github.com/${GITHUB_ORG}/${GITHUB_REPO}"

# Upgrade all Alpine packages for latest security patches (openssl >= 3.5.8-r0, busybox, etc.)
# Pin npm EXACTLY at 11.19.1 (see base stage): bundled tar 7.5.22 clears GHSA-r292-9mhp-454m
RUN apk update && \
    apk upgrade --no-cache && \
    npm install -g npm@11.19.1 && \
    npm cache clean --force

# Install dumb-init and create non-root user in a single layer
RUN apk add --no-cache dumb-init && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy package files (.npmrc maps @figurecollecting to GitHub Packages; placeholder token only)
COPY package*.json .npmrc ./

# Install production dependencies only
# Using --ignore-scripts for security to prevent execution of npm scripts.
# Token via BuildKit secret mount — never written to a layer.
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)" npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# Copy built application from builder
# Files are owned by root:root (read-only for non-root)
COPY --from=builder --chown=root:root /app/dist ./dist

# Create a writable directory for runtime data if needed
RUN mkdir -p /app/data /app/logs && \
    chown nodejs:nodejs /app/data /app/logs && \
    chmod 755 /app/data /app/logs

# Switch to non-root user (nodejs:1001)
USER nodejs

# Expose port
EXPOSE 5050

# Health check using Node.js (not curl)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "const req = require('http').get('http://localhost:5050/health', { timeout: 5000 }, (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); req.on('timeout', () => { req.destroy(); process.exit(1); }); req.on('error', () => process.exit(1));"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start application
CMD ["node", "dist/index.js"]
