import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  timestamp: string;
  path: string;
}

/**
 * Catch-all HTTP exception filter for the worker. Without it, any error thrown
 * in a controller or service that is not an HttpException reaches the client as
 * a bare 500 with no logging.
 *
 * Responsibilities:
 *   - Map known errors to the right status: HttpException keeps its own status
 *     (this is how the scraper-abort 503s reach ml-service intact); everything
 *     else is a 500.
 *   - Log every failure with method + path. 5xx logs at error level with the
 *     stack; 4xx logs at warn level (expected client errors, no stack noise).
 *   - Return a consistent JSON body and never expose internal messages/stacks
 *     for 5xx responses.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{ method?: string }>();
    const path = httpAdapter.getRequestUrl(request) ?? '';
    const method = request?.method ?? '';

    const { status, error, message, body: structuredBody } = this.resolve(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${method} ${path} → ${status} ${error}: ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${method} ${path} → ${status} ${error}: ${message}`);
    }

    // Structured HttpException payloads (e.g. the scraper-abort body) are passed
    // through verbatim so ml-service can read `reason`/`diagnostics_dir`.
    if (structuredBody) {
      httpAdapter.reply(ctx.getResponse(), structuredBody, status);
      return;
    }

    const responseBody: ErrorBody = {
      statusCode: status,
      error,
      // Never surface internal details on a 5xx; clients get a generic message
      // while the real cause stays in the logs above.
      message: status >= HttpStatus.INTERNAL_SERVER_ERROR ? 'Internal server error' : message,
      timestamp: new Date().toISOString(),
      path,
    };

    httpAdapter.reply(ctx.getResponse(), responseBody, status);
  }

  /**
   * Maps an unknown thrown value to an HTTP status, a short error label, and a
   * client-safe message. HttpExceptions are honored as-is (object responses are
   * returned unchanged via `body`); anything else is a 500.
   */
  private resolve(exception: unknown): {
    status: number;
    error: string;
    message: string;
    body?: unknown;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null) {
        const message = (res as { message?: string | string[] }).message ?? exception.message;
        return {
          status,
          error: HttpStatus[status] ?? 'Error',
          message: Array.isArray(message) ? message.join(', ') : message,
          // Preserve the structured object (scraper-abort payloads carry `reason`).
          body: res,
        };
      }
      return {
        status,
        error: HttpStatus[status] ?? 'Error',
        message: res,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: exception instanceof Error ? exception.message : String(exception),
    };
  }
}
