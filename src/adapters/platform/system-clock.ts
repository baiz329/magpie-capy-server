import type { ClockPort } from "../../ports/platform.ts";

export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      (timer as { unref?: () => void }).unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
