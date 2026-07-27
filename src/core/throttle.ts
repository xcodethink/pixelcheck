/**
 * Per-origin throttle: serializes work that targets the same origin to avoid
 * tripping rate limits / WAFs, while allowing different origins to run in
 * parallel under the global concurrency cap.
 */

type Task<T> = () => Promise<T>;

export class OriginThrottle {
  private queues = new Map<string, Promise<unknown>>();

  async run<T>(origin: string, task: Task<T>): Promise<T> {
    const previous = this.queues.get(origin) ?? Promise.resolve();
    let resolveCurrent: (value: T | PromiseLike<T>) => void;
    let rejectCurrent: (reason?: unknown) => void;
    const current = new Promise<T>((res, rej) => {
      resolveCurrent = res;
      rejectCurrent = rej;
    });
    this.queues.set(
      origin,
      previous.then(() => current.catch(() => undefined)),
    );

    try {
      await previous;
      const result = await task();
      resolveCurrent!(result);
      return result;
    } catch (err) {
      rejectCurrent!(err);
      throw err;
    } finally {
      // Clean up empty origin queues
      if (this.queues.get(origin) === current) {
        this.queues.delete(origin);
      }
    }
  }
}

/**
 * Best-effort extract origin from a URL string.
 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "default";
  }
}
