/** One-shot CLI commands may have leaked transport handles after durable work ends. */
export async function runCliEntrypoint(
  main: () => Promise<void>,
  options: { serve?: boolean; graceMs?: number; forceExit?: (code: number) => void } = {},
): Promise<void> {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  }
  process.exitCode = exitCode;
  if (options.serve) return;
  const timer = setTimeout(() => (options.forceExit ?? process.exit)(exitCode), options.graceMs ?? 2_000);
  timer.unref();
}
