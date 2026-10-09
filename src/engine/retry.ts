import { DiscordApiError } from "../util/errors.js";
import { sleep as realSleep } from "../util/names.js";

export interface RetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 30_000 };

export interface RetryHooks<T> {
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: DiscordApiError }) => void;
  /**
   * Called before retrying after an *ambiguous* failure (timeout / 5xx), where Discord may have
   * processed the request. Return a value to treat the operation as already done.
   */
  reconcile?: (error: DiscordApiError) => Promise<T | undefined>;
  random?: () => number;
}

/**
 * Retry with exponential backoff and jitter, bounded by `maxAttempts`. Honors Discord's
 * `retry_after` when present. Never retries client errors (4xx other than 429).
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY, hooks: RetryHooks<T> = {}): Promise<{ value: T; attempts: number }> {
  const sleep = hooks.sleep ?? realSleep;
  const random = hooks.random ?? Math.random;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (err) {
      if (!(err instanceof DiscordApiError) || !err.retryable || attempt >= policy.maxAttempts) throw err;
      if (err.ambiguous && hooks.reconcile) {
        const recovered = await hooks.reconcile(err);
        if (recovered !== undefined) return { value: recovered, attempts: attempt };
      }
      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.min(policy.maxDelayMs, err.retryAfterMs ?? Math.round(backoff * (0.5 + random() / 2)));
      hooks.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
