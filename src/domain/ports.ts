import type { NewShipment, Shipment, TrackingEvent } from "./types.ts";

/** Origem dos eventos de rastreio. Devolve eventos já no formato do domínio. */
export interface TrackingProvider {
  register(code: string, carrier: string): Promise<void>;
  fetchEvents(code: string): Promise<TrackingEvent[]>;
}

/** Qualquer falha ao falar com a origem: rede, timeout, status HTTP ou payload fora do contrato. */
export class TrackingProviderError extends Error {
  override name = "TrackingProviderError";
}

export interface ShipmentRepository {
  /** Se o código já existe, devolve o envio existente sem alterar nada. */
  create(shipment: NewShipment): Promise<Shipment>;
  findById(id: string): Promise<Shipment | null>;
  findByCode(code: string): Promise<Shipment | null>;
  list(): Promise<Shipment[]>;
  /** Eventos que já estão no histórico são ignorados. */
  addEvents(shipmentId: string, events: TrackingEvent[]): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Logger {
  warn(context: Record<string, unknown>, message: string): void;
}
