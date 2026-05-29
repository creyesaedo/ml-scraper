import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import appConfig from '../../config/app.config';

/**
 * Thrown when the circuit breaker has tripped. Callers should abort the sync
 * and let the orchestrator (ProductCollectionService / SyncRunnerService)
 * persist progress so the work can be resumed later.
 */
export class CircuitBreakerOpenError extends Error {
  constructor(message = 'Scraper circuit breaker is open') {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

export interface FailureSample {
  timestamp: string;
  url: string;
  siteId?: string;
  categoryMlId?: string;
  status?: number | null;
  errorMessage: string;
  responseSnippet?: string;
}

const MAX_SAMPLES_KEPT = 20;

/**
 * Tracks consecutive *hard* scraper failures (network error, BD HTTP error, or
 * a Bright Data x-brd-err-code on the response). Partial renders (<50 KB HTML
 * with a clean HTTP 200) are NOT
 * failures here — they are handled separately and return EMPTY_ENRICHMENT.
 *
 * When the consecutive count reaches SCRAPER_FAILURE_THRESHOLD:
 *   1. `tripped` flag is set, future assertOpen() calls throw.
 *   2. Diagnostics are dumped to {SCRAPER_FAILURE_DUMP_DIR}/{timestamp}/:
 *      - error.log    : JSON of last N FailureSample entries (no HTML)
 *      - sample.html  : raw response body of the most recent failure
 *      - context.json : trip metadata (count, threshold, last URL, etc.)
 *   3. CircuitBreakerOpenError is thrown to the caller.
 *
 * The service is a singleton across all backends. Call reset() before a fresh
 * sync run.
 */
@Injectable()
export class ScraperHealthService {
  private readonly logger = new Logger(ScraperHealthService.name);
  private readonly threshold: number;
  private readonly dumpDir: string;

  private consecutiveFailures = 0;
  private tripped = false;
  private trippedAt: Date | null = null;
  private samples: FailureSample[] = [];
  private lastFailingBody: string | null = null;
  private lastFailingContext: FailureSample | null = null;
  private lastDumpDir: string | null = null;

  constructor(@Inject(appConfig.KEY) config: ConfigType<typeof appConfig>) {
    this.threshold = config.scraperFailureThreshold;
    this.dumpDir = config.scraperFailureDumpDir;
  }

  /** Call before issuing a scrape request. Throws if breaker is open. */
  assertOpen(): void {
    if (this.tripped) {
      throw new CircuitBreakerOpenError(
        `Circuit breaker open since ${this.trippedAt?.toISOString()} ` +
          `(${this.consecutiveFailures} consecutive failures, threshold=${this.threshold}). ` +
          `Diagnostics: ${this.lastDumpDir ?? '(none)'}`,
      );
    }
  }

  reportSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.logger.debug(`Success after ${this.consecutiveFailures} failures — counter reset`);
    }
    this.consecutiveFailures = 0;
  }

  /**
   * Report a hard failure. Stores the sample; if the threshold is reached,
   * dumps diagnostics, sets the tripped flag, and throws
   * CircuitBreakerOpenError synchronously (after the dump finishes).
   */
  async reportFailure(sample: FailureSample, responseBody?: string): Promise<void> {
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES_KEPT) {
      this.samples.shift();
    }
    if (responseBody !== undefined) {
      this.lastFailingBody = responseBody;
    }
    this.lastFailingContext = sample;
    this.consecutiveFailures += 1;

    this.logger.warn(
      `Scraper failure ${this.consecutiveFailures}/${this.threshold} — ` +
        `${sample.url} :: ${sample.errorMessage}`,
    );

    if (this.consecutiveFailures >= this.threshold && !this.tripped) {
      this.tripped = true;
      this.trippedAt = new Date();
      try {
        await this.dumpDiagnostics();
      } catch (err) {
        this.logger.error(
          `Failed to dump circuit-breaker diagnostics: ${(err as Error).message}`,
        );
      }
      throw new CircuitBreakerOpenError(
        `Tripped after ${this.consecutiveFailures} consecutive failures. ` +
          `Diagnostics: ${this.lastDumpDir ?? '(dump failed)'}`,
      );
    }
  }

  /** Reset breaker state — call before starting a fresh sync run. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.tripped = false;
    this.trippedAt = null;
    this.samples = [];
    this.lastFailingBody = null;
    this.lastFailingContext = null;
    this.lastDumpDir = null;
  }

  getState(): {
    consecutiveFailures: number;
    tripped: boolean;
    threshold: number;
    lastDumpDir: string | null;
  } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      tripped: this.tripped,
      threshold: this.threshold,
      lastDumpDir: this.lastDumpDir,
    };
  }

  private async dumpDiagnostics(): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.resolve(this.dumpDir, ts);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(
      path.join(dir, 'error.log'),
      JSON.stringify(this.samples, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'context.json'),
      JSON.stringify(
        {
          tripped_at: this.trippedAt?.toISOString(),
          consecutive_failures: this.consecutiveFailures,
          threshold: this.threshold,
          last_failure: this.lastFailingContext,
          sample_count: this.samples.length,
        },
        null,
        2,
      ),
      'utf8',
    );
    if (this.lastFailingBody !== null) {
      await fs.writeFile(path.join(dir, 'sample.html'), this.lastFailingBody, 'utf8');
    }

    this.lastDumpDir = dir;
    this.logger.error(`Circuit breaker tripped. Diagnostics written to ${dir}`);
  }
}
