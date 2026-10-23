/** Reserve bootstrap work first, then continue daemon wiring without waiting
 * for a model turn. The runner owns serialization and the attempt deadline. */
export async function beginStartupInitialization(options: {
  bootstrap?: () => Promise<void>;
  next: () => void;
  logger: Pick<Console, "info" | "warn">;
}): Promise<void> {
  if (options.bootstrap) {
    try {
      const pending = options.bootstrap();
      void pending.then(
        () => options.logger.info("[startup] Background bootstrap completed"),
        (error) =>
          options.logger.warn(
            `[startup] Background bootstrap failed: ${error instanceof Error ? error.message : "unknown error"}`,
          ),
      );
    } catch (error) {
      options.logger.warn(
        `[startup] Background bootstrap failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  options.next();
}
