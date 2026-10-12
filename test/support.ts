import type { Clock, Logger, TrackingProvider } from "../src/domain/ports.ts";
import type { ShipmentStatus, TrackingEvent } from "../src/domain/types.ts";

export function event(
  status: ShipmentStatus | null,
  occurredAt: string,
  overrides: Partial<TrackingEvent> = {},
): TrackingEvent {
  return {
    externalId: null,
    occurredAt: new Date(occurredAt),
    status,
    rawStatus: status ?? "status inventado",
    location: null,
    ...overrides,
  };
}

export class FixedClock implements Clock {
  private current: Date;

  constructor(now: string) {
    this.current = new Date(now);
  }

  now(): Date {
    return this.current;
  }

  set(now: string): void {
    this.current = new Date(now);
  }
}

/** Implementação em memória da porta, para testar a regra sem HTTP. */
export class FakeTrackingProvider implements TrackingProvider {
  registered: string[] = [];
  events: TrackingEvent[] = [];
  failure: Error | null = null;

  async register(code: string): Promise<void> {
    if (this.failure !== null) throw this.failure;
    this.registered.push(code);
  }

  async fetchEvents(): Promise<TrackingEvent[]> {
    if (this.failure !== null) throw this.failure;
    return this.events;
  }
}

export class RecordingLogger implements Logger {
  messages: string[] = [];

  warn(_context: Record<string, unknown>, message: string): void {
    this.messages.push(message);
  }
}
