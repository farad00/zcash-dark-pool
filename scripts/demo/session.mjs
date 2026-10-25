// Disposable manual-demo lifetime only; never a market/issuance deadline.
export const MANUAL_DEMO_DURATION_MS = 30 * 60 * 1000;

export async function waitForManualStop(stopped, stop) {
  const timer = setTimeout(stop, MANUAL_DEMO_DURATION_MS);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await stopped;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
