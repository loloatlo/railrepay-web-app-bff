# Multi-stage Dockerfile for web-app-bff
# Railway deployment — stateless BFF (no database, no migrations)
#
# ADR-023: Web Channel BFF Architecture
# ADR-005: Railway native rollback

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ONLY production dependencies
RUN npm ci --only=production

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist ./dist

# Set environment to production
ENV NODE_ENV=production

# Expose port (Railway overrides with $PORT at runtime)
EXPOSE 3000

# Health check per ADR-008
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# BFF is stateless — no DB, no migrations
CMD node dist/index.js
