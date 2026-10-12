import { TrackingProviderError } from "../../domain/ports.ts";
import type { Logger, TrackingProvider } from "../../domain/ports.ts";
import type { TrackingEvent } from "../../domain/types.ts";
// O texto de status é da transportadora, não do agregador: a tabela de tradução é a mesma.
import { translateStatus } from "../aggregator/statusMap.ts";
import { parseRawParcel } from "./payload.ts";

export interface ParcelHubClientOptions {
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
}

export class ParcelHubClient implements TrackingProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: ParcelHubClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
  }

  async register(code: string, carrier: string): Promise<void> {
    // O PUT é idempotente: repetir o cadastro devolve 200 em vez de erro.
    const response = await this.request(`/api/parcels/${encodeURIComponent(code)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ carrier }),
    });

    if (!response.ok) {
      throw new TrackingProviderError(`parcelhub answered ${response.status} on register`);
    }
  }

  async fetchEvents(code: string): Promise<TrackingEvent[]> {
    const response = await this.request(`/api/parcels/${encodeURIComponent(code)}`, { method: "GET" });
    if (!response.ok) {
      throw new TrackingProviderError(`parcelhub answered ${response.status} on fetch`);
    }

    const parcel = parseRawParcel(await this.readJson(response));
    if (parcel === null) {
      throw new TrackingProviderError("parcelhub payload is not a parcel");
    }

    const events: TrackingEvent[] = [];
    for (const raw of parcel.history) {
      const event = this.toEvent(parcel.carrier, raw);
      if (event !== null) events.push(event);
    }
    return events;
  }

  private toEvent(carrier: string, raw: unknown): TrackingEvent | null {
    if (typeof raw !== "object" || raw === null) {
      this.logger.warn({ event: raw }, "evento ignorado: não é um objeto");
      return null;
    }

    const { uid, at_ms, description, place } = raw as Record<string, unknown>;

    if (typeof description !== "string") {
      this.logger.warn({ event: raw }, "evento ignorado: sem description");
      return null;
    }

    const occurredAt = parseTime(at_ms);
    if (occurredAt === null) {
      this.logger.warn({ event: raw }, "evento ignorado: at_ms inválido");
      return null;
    }

    const status = translateStatus(carrier, description);
    if (status === null) {
      this.logger.warn({ carrier, description }, "status da transportadora sem tradução");
    }

    return {
      externalId: typeof uid === "string" ? uid : null,
      occurredAt,
      status,
      rawStatus: description,
      location: parsePlace(place),
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(this.baseUrl + path, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      throw new TrackingProviderError("parcelhub request failed", { cause });
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw new TrackingProviderError("parcelhub body is not JSON", { cause });
    }
  }
}

// Só número inteiro de milissegundos que vira uma data válida. Texto, fração e
// valores fora do alcance de Date são recusados.
function parseTime(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// O domínio guarda o local como um texto só, no formato "Cidade/UF".
function parsePlace(place: unknown): string | null {
  if (typeof place !== "object" || place === null) return null;

  const { city, state } = place as Record<string, unknown>;
  if (typeof city !== "string") return null;
  return typeof state === "string" ? `${city}/${state}` : city;
}
