FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .
RUN npm run build

# ---

FROM node:20-slim AS production

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Worker default port (see src/main.ts). No database — this is a pure scraper.
ENV PORT=8001
EXPOSE 8001

CMD ["node", "dist/main"]
