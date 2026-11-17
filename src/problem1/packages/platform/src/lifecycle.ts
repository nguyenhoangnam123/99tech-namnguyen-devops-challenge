import type { Logger } from './logger.js';

type Closer = () => Promise<void>;

// Closes resources in reverse start order on SIGTERM or SIGINT.
export class Lifecycle {
  private readonly closers: { name: string; close: Closer }[] = [];
  private stopping = false;

  constructor(
    private readonly logger: Logger,
    private readonly timeoutMs = 10_000,
  ) {}

  onShutdown(name: string, close: Closer): void {
    this.closers.push({ name, close });
  }

  listen(): void {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => void this.shutdown(signal));
    }
  }

  async shutdown(reason: string, exitCode = 0): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info({ reason }, 'shutting down');
    const timer = setTimeout(() => {
      this.logger.error('shutdown timed out');
      process.exit(1);
    }, this.timeoutMs);
    for (const { name, close } of [...this.closers].reverse()) {
      await close().catch((error: unknown) => {
        this.logger.error({ err: error, name }, 'close failed');
      });
    }
    clearTimeout(timer);
    process.exit(exitCode);
  }

  // A crashed worker must take the process down so it gets restarted.
  failFast(name: string): (error: unknown) => void {
    return (error) => {
      this.logger.fatal({ err: error, name }, 'fatal error');
      void this.shutdown(`${name} failed`, 1);
    };
  }
}
