# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source
COPY . .

# Build frontend (dist/public) + backend (dist/index.js)
RUN npm run build

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Which commit is this? Without it, a probe cannot tell a new revision that is
# serving from an old one that never got replaced -- the two look identical over
# HTTP, and that ambiguity is what had a healthy production rolled back.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT

# Only copy what's needed to run
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

# Expose the app port
EXPOSE 5173

CMD ["node", "dist/index.js"]
