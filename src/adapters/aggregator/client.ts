import { TrackingProviderError } from "../../domain/ports.ts";
import type { Logger, TrackingProvider } from "../../domain/ports.ts";
import type { TrackingEvent } from "../../domain/types.ts";
import { parseRawTracking } from "./payload.ts";
import { translateStatus } from "./statusMap.ts";

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export interface AggregatorClientOptions {
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
}

export class AggregatorClient implements TrackingProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: AggregatorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
  }

  async register(code: string, carrier: string): Promise<void> {
    const response = await this.request("/v1/trackings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tracking_number: code, courier: carrier }),
    });

    // 409 é "já cadastrado": acontece ao repetir um cadastro que falhou depois do agregador aceitar.
    if (!response.ok && response.status !== 409) {
      throw new TrackingProviderError(`aggregator answered ${response.status} on register`);
    }
  }

  async fetchEvents(code: string): Promise<TrackingEvent[]> {
    const response = await this.request(`/v1/trackings/${encodeURIComponent(code)}`, { method: "GET" });
    if (!response.ok) {
      throw new TrackingProviderError(`aggregator answered ${response.status} on fetch`);
    }

    const tracking = parseRawTracking(await this.readJson(response));
    if (tracking === null) {
      throw new TrackingProviderError("aggregator payload is not a tracking");
    }

    const events: TrackingEvent[] = [];
    for (const checkpoint of tracking.checkpoints) {
      const event = this.toEvent(tracking.courier, checkpoint);
      if (event !== null) events.push(event);
    }
    return events;
  }

  private toEvent(carrier: string, checkpoint: unknown): TrackingEvent | null {
    if (typeof checkpoint !== "object" || checkpoint === null) {
      this.logger.warn({ checkpoint }, "checkpoint ignorado: não é um objeto");
      return null;
    }

    const { checkpoint_id, checkpoint_time, status_text, city } = checkpoint as Record<string, unknown>;

    if (typeof status_text !== "string") {
      this.logger.warn({ checkpoint }, "checkpoint ignorado: sem status_text");
      return null;
    }

    const occurredAt = parseTime(checkpoint_time);
    if (occurredAt === null) {
      this.logger.warn({ checkpoint }, "checkpoint ignorado: checkpoint_time inválido ou sem offset");
      return null;
    }

    const status = translateStatus(carrier, status_text);
    if (status === null) {
      this.logger.warn({ carrier, status_text }, "status da transportadora sem tradução");
    }

    return {
      externalId: typeof checkpoint_id === "string" ? checkpoint_id : null,
      occurredAt,
      status,
      rawStatus: status_text,
      location: typeof city === "string" ? city : null,
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(this.baseUrl + path, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      throw new TrackingProviderError("aggregator request failed", { cause });
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw new TrackingProviderError("aggregator body is not JSON", { cause });
    }
  }
}

// Sem offset a ordem entre eventos fica ambígua, então o horário é recusado.
function parseTime(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value)) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
