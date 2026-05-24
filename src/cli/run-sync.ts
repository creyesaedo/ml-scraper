import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import type { AppMode } from '../config/app.config';
import { PrismaService } from '../prisma/prisma.service';
import { SyncRunnerService } from '../sync/sync-runner.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Neon's free tier suspends compute after ~5 min of inactivity. The first
// query against a suspended instance can take 5-15s to wake it up and the
// connection times out before that. Retry the wake-up query with backoff
// so the actual sync starts against a warm database.
async function warmupDatabase(prisma: PrismaService, logger: Logger): Promise<void> {
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      const start = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      logger.log(`Database warm (attempt ${i}, ${Date.now() - start}ms)`);
      return;
    } catch (err) {
      const msg = (err as Error).message.split('\n')[0];
      if (i === attempts) {
        logger.error(`Database warmup failed after ${attempts} attempts: ${msg}`);
        throw err;
      }
      logger.warn(`Database warmup attempt ${i}/${attempts} failed: ${msg} — retrying in ${i * 2}s`);
      await sleep(i * 2000);
    }
  }
}

async function main(): Promise<void> {
  const logger = new Logger('SyncCLI');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  const config = app.get(ConfigService);
  const prisma = app.get(PrismaService);
  const runner = app.get(SyncRunnerService);

  try {
    await warmupDatabase(prisma, logger);
  } catch {
    await app.close();
    process.exit(1);
  }

  const appMode = config.get<AppMode>('app.appMode') ?? 'DEVELOPMENT';
  const configuredSites = config.get<string[]>('app.snapshotSiteIds') ?? [];
  const categoriesBySite =
    config.get<Record<string, string[]>>('app.snapshotCategoriesBySite') ?? {};

  const argSite = process.argv[2]?.toUpperCase();
  const siteIds = argSite ? [argSite] : configuredSites;

  if (siteIds.length === 0) {
    logger.error('No site IDs to process. Set APP_MODE or pass a site as argv.');
    await app.close();
    process.exit(1);
  }

  if (appMode === 'DEVELOPMENT') {
    const sampleCat = categoriesBySite[siteIds[0]]?.[0] ?? '(no whitelist)';
    logger.log(`APP_MODE=DEVELOPMENT — scraping ${siteIds[0]} / ${sampleCat} only`);
  } else {
    logger.log(`APP_MODE=PRODUCTION — scraping ${siteIds.length} sites: ${siteIds.join(', ')}`);
  }

  let exitCode = 0;
  for (const siteId of siteIds) {
    try {
      const result = (await runner.run(siteId)) as {
        productos?: { aborted?: unknown };
      };
      logger.log(`[${siteId}] done: ${JSON.stringify(result)}`);
      if (result.productos?.aborted) {
        logger.error(`[${siteId}] circuit breaker tripped — see diagnostics dir`);
        exitCode = 1;
      }
    } catch (err) {
      logger.error(`[${siteId}] failed`, err as Error);
      exitCode = 1;
    }
  }

  await app.close();
  process.exit(exitCode);
}

void main();
