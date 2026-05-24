import { defineConfig } from '@prisma/config';
import * as dotenv from 'dotenv';

// Prisma 7 with prisma.config.ts no longer auto-loads .env — do it manually.
dotenv.config();

// Prisma CLI (migrate / db push) needs a direct connection — pgBouncer in
// transaction mode (used by Neon's pooler) rejects DDL. Falls back to
// DATABASE_URL when DIRECT_URL is not set (e.g. local Docker Postgres).
export default defineConfig({
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  },
});
