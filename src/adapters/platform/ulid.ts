import { randomBytes, randomUUID } from "node:crypto";

import type { IdPort } from "../../ports/platform.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now(), random = randomBytes(10)): string {
  let time = Math.max(0, Number(now) || 0);
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = ALPHABET[time % 32] ?? "0";
    time = Math.floor(time / 32);
  }
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  const randomChars = new Array<string>(16);
  for (let i = 15; i >= 0; i -= 1) {
    randomChars[i] = ALPHABET[Number(bits & 31n)] ?? "0";
    bits >>= 5n;
  }
  return timeChars.join("") + randomChars.join("");
}

export class SystemIds implements IdPort {
  ulid(now?: number): string {
    return ulid(now);
  }

  uuid(): string {
    return randomUUID();
  }
}
