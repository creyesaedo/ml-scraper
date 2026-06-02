import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '../generated/prisma/client';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  timestamp: string;
  path: string;
}

/**
 * Catch-all HTTP exception filter. Without it, any error thrown in a controller
 * or service that is not an HttpException reaches the client as a bare 500 with
 * no logging — including raw Prisma errors that may leak schema/column names.
 *
 * Responsibilities:
 *   - Map known errors to the right status: HttpException keeps its own status;
 *     Prisma errors are translated (see `resolve`); everything else is a 500.
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

    const { status, error, message } = this.resolve(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${method} ${path} → ${status} ${error}: ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${method} ${path} → ${status} ${error}: ${message}`);
    }

    const body: ErrorBody = {
      statusCode: status,
      error,
      // Never surface internal details on a 5xx; clients get a generic message
      // while the real cause stays in the logs above.
      message:
        status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? 'Internal server error'
          : message,
      timestamp: new Date().toISOString(),
      path,
    };

    httpAdapter.reply(ctx.getResponse(), body, status);
  }

  /**
   * Maps an unknown thrown value to an HTTP status, a short error label, and a
   * client-safe message. HttpExceptions are honored as-is; Prisma errors are
   * translated to the closest HTTP semantics; anything else is a 500.
   */
  private resolve(exception: unknown): {
    status: number;
    error: string;
    message: string;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      // HttpException responses are either a string or an object with `message`.
      const message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string | string[] }).message ?? exception.message);
      return {
        status,
        error: HttpStatus[status] ?? 'Error',
        message: Array.isArray(message) ? message.join(', ') : message,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.resolvePrismaKnown(exception);
    }

    // DB unreachable / auth failure on connect — the service is down, not the
    // request's fault.
    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        message: 'Database is currently unavailable',
      };
    }

    // Malformed query arguments — a bug or bad input that reached Prisma.
    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: 'Invalid query parameters',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: exception instanceof Error ? exception.message : String(exception),
    };
  }

  /** Translates the Prisma error codes we can hit into HTTP responses. */
  private resolvePrismaKnown(exception: Prisma.PrismaClientKnownRequestError): {
    status: number;
    error: string;
    message: string;
  } {
    switch (exception.code) {
      case 'P2002': // unique constraint violation
        return {
          status: HttpStatus.CONFLICT,
          error: 'Conflict',
          message: 'A record with these values already exists',
        };
      case 'P2003': // foreign key constraint violation
        return {
          status: HttpStatus.CONFLICT,
          error: 'Conflict',
          message: 'Referenced record does not exist',
        };
      case 'P2025': // record required but not found
        return {
          status: HttpStatus.NOT_FOUND,
          error: 'Not Found',
          message: 'Record not found',
        };
      default:
        // Other known request errors are most often malformed input rather than
        // a server fault; surface as 400 without leaking the Prisma code text.
        return {
          status: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          message: `Database request error (${exception.code})`,
        };
    }
  }
}
