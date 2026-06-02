FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

RUN npm install

RUN npx prisma generate

COPY . .
RUN npm run build

# ---

FROM node:20-slim AS production

# OpenSSL is required by the Prisma CLI used at container start (prisma db push).
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# prisma is a runtime dependency, so the CLI ships in the image (no network
# npx fetch) for the `prisma db push` run on startup. The generated client is
# already compiled into dist/ by the builder, so no `prisma generate` here.
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

CMD ["node", "dist/main"]
