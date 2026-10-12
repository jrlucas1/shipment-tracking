import type { Clock } from "../domain/ports.ts";

export const systemClock: Clock = {
  now: () => new Date(),
};
