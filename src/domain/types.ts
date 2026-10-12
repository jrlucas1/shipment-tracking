export const SHIPMENT_STATUSES = [
  "posted",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "exception",
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export interface TrackingEvent {
  /** Id do evento na origem, quando ela fornece um. */
  externalId: string | null;
  /** Momento em que o evento aconteceu na transportadora, não quando chegou aqui. */
  occurredAt: Date;
  /** `null` quando o texto da transportadora não tem tradução conhecida. */
  status: ShipmentStatus | null;
  rawStatus: string;
  location: string | null;
}

export interface Shipment {
  id: string;
  code: string;
  carrier: string;
  /** Limite próprio deste envio; `null` usa o limite global. */
  delayLimitHours: number | null;
  createdAt: Date;
  /** Histórico em ordem crescente de `occurredAt`. */
  events: TrackingEvent[];
}

export interface NewShipment {
  code: string;
  carrier: string;
  delayLimitHours: number | null;
  createdAt: Date;
}
