# Production image for Fly.io (see README Part C).
#
# Debian slim rather than Alpine: Prisma's query engine needs OpenSSL, and the
# glibc build is the one Prisma detects without extra binaryTargets config.
FROM node:22-slim

RUN apt-get update -qq \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dev dependencies are needed at build time — `react-router build` runs Vite,
# which lives in devDependencies. NODE_ENV is only flipped to production after
# the build so `npm ci` does not skip them.
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# Chromium + its system libraries for the browser-layer checks (Web Bot Auth).
# Kept as its own layer, before COPY . ., so an app-code change doesn't bust
# the ~300MB download cache.
RUN npx playwright install --with-deps chromium

COPY . .

# Generate the Prisma client for *this* platform, then build the app.
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

CMD ["npm", "run", "docker-start"]
