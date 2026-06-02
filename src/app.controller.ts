import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  /** Liveness probe used by Docker/uptime checks. Always returns 200 OK. */
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}
