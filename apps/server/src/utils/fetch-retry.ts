const RETRY_TIMEOUT_MS = 300_000; // 5 minutes

function isTimeoutError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    msg.includes("timed out") ||
    msg.includes("timeout")
  );
}

/** Fetch with 5-minute timeout and retry. For non-streaming requests only.
 *  Streaming requests should use plain fetch without any timeout. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 1
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(RETRY_TIMEOUT_MS),
      });
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isTimeoutError(lastError) || attempt >= maxRetries) {
        throw lastError;
      }
      // Timeout: retry
    }
  }

  throw lastError ?? new Error("Fetch retry exhausted");
}
