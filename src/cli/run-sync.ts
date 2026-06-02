import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import type { AppConfig, AppMode } from '../config/app.config';
import { PrismaService } from '../prisma/prisma.service';
import { CategorySyncService } from '../sync/category-sync.service';
import { SyncRunnerService } from '../sync/sync-runner.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Process-level guards for this short-lived CLI. main() already wraps its own
// steps in try/catch, but a rejection or throw escaping it (or a stray async
// task) would otherwise exit 0 and make GitHub Actions report a green run for a
// sync that actually failed. Log with context and exit non-zero so CI fails.
function installProcessGuards(logger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason instanceof Error ? reason.stack : reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', err.stack ?? err.message);
    process.exit(1);
  });
}

// In DEVELOPMENT mode, after the random site is picked at config load, pick a
// random parent category for that site from the DB and inject it as the
// whitelist. Categories must already be synced; if not, we trigger the sync
// here so the random pick has something to choose from.
async function pickRandomDevelopmentCategory(
  app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>,
  siteId: string,
  logger: Logger,
): Promise<void> {
  const prisma = app.get(PrismaService);
  const config = app.get(ConfigService);

  let count = await prisma.category.count({
    where: { country: siteId, parent_id: null },
  });

  if (count === 0) {
    logger.log(`No categories cached for ${siteId} — running category sync first`);
    const categorySync = app.get(CategorySyncService);
    await categorySync.sync();
    count = await prisma.category.count({
      where: { country: siteId, parent_id: null },
    });
  }

  if (count === 0) {
    throw new Error(`No parent categories found for ${siteId} after sync`);
  }

  const skip = Math.floor(Math.random() * count);
  const cat = await prisma.category.findFirst({
    where: { country: siteId, parent_id: null },
    orderBy: { id: 'asc' },
    skip,
  });

  if (!cat) {
    throw new Error(`Failed to fetch random category for ${siteId} (skip=${skip}, count=${count})`);
  }

  logger.log(
    `DEVELOPMENT pick: ${siteId} / ${cat.ml_id} "${cat.name}" (${count} parent categories available)`,
  );
  // ConfigService.set() does NOT propagate into registerAs() namespaces — they
  // hold their own object reference. Mutate the registered object directly so
  // ProductCollectionService picks up the override when it reads the whitelist.
  const appConfigRef = config.get<AppConfig>('app');
  if (appConfigRef) {
    appConfigRef.snapshotCategoriesBySite = { [siteId]: [cat.ml_id] };
  }
}

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

/**
 * CLI entry point used by GitHub Actions and local/ad-hoc runs.
 *
 * Boots a standalone Nest context (no HTTP server), warms up the database
 * (Neon's free tier sleeps when idle), figures out which sites to process from
 * APP_MODE or an optional siteId argument, and runs the sync for each. In
 * DEVELOPMENT mode it first injects a random category as the whitelist to keep
 * the run cheap. Exits non-zero if any site fails or the circuit breaker trips.
 */
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

  const argSite = process.argv[2]?.toUpperCase();
  const siteIds = argSite ? [argSite] : configuredSites;

  if (siteIds.length === 0) {
    logger.error('No site IDs to process. Set APP_MODE or pass a site as argv.');
    await app.close();
    process.exit(1);
  }

  if (appMode === 'DEVELOPMENT') {
    logger.log(`APP_MODE=DEVELOPMENT — randomized site: ${siteIds[0]}`);
    try {
      await pickRandomDevelopmentCategory(app, siteIds[0], logger);
    } catch (err) {
      logger.error(`Failed to pick random DEVELOPMENT category: ${(err as Error).message}`);
      await app.close();
      process.exit(1);
    }
  } else {
    logger.log(`APP_MODE=PRODUCTION — scraping ${siteIds.length} sites: ${siteIds.join(', ')}`);
  }

  let exitCode = 0;
  for (let i = 0; i < siteIds.length; i++) {
    const siteId = siteIds[i];
    logger.log(`[${siteId}] (${i + 1}/${siteIds.length}) starting`);
    const start = Date.now();
    try {
      const result = (await runner.run(siteId)) as {
        productos?: { aborted?: unknown; productos_guardados?: number };
      };
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const saved = result.productos?.productos_guardados ?? 0;
      logger.log(`[${siteId}] done in ${elapsed}s — ${saved} products saved`);
      logger.log(`[${siteId}] result: ${JSON.stringify(result)}`);
      if (result.productos?.aborted) {
        logger.error(`[${siteId}] circuit breaker tripped — see diagnostics dir`);
        exitCode = 1;
      }
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      logger.error(`[${siteId}] failed after ${elapsed}s`, err as Error);
      exitCode = 1;
    }
  }

  await app.close();
  process.exit(exitCode);
}

const cliLogger = new Logger('SyncCLI');
installProcessGuards(cliLogger);

main().catch((err: unknown) => {
  // main() exits the process itself on the paths it handles; this catches
  // anything that throws before/around that (e.g. NestFactory failing to build
  // the application context) so the CLI never exits 0 on an unhandled failure.
  cliLogger.error(
    'Sync CLI crashed before completing',
    err instanceof Error ? err.stack : String(err),
  );
  process.exit(1);
});
