import { Logger } from '@nestjs/common';

// Silence NestJS logger output during unit tests. The services under test log
// their normal progress and (deliberately exercised) error paths via Logger;
// those messages are expected and only add noise to the test output. Disabling
// the logger keeps the run showing just PASS/FAIL.
Logger.overrideLogger(false);
