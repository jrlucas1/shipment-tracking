import type { ShipmentStatus, TrackingEvent } from "./types.ts";

// Só desempata eventos com o mesmo `occurredAt`: vence o que está mais adiante no fluxo.
const TIE_BREAK_RANK: Record<ShipmentStatus, number> = {
  posted: 0,
  in_transit: 1,
  out_for_delivery: 2,
  exception: 3,
  delivered: 4,
};

/**
 * Status atual a partir do histórico inteiro, em qualquer ordem de chegada.
 *
 * Vale o evento que aconteceu por último na transportadora. Eventos sem tradução
 * não participam. `delivered` é terminal: depois dele nenhum evento muda o status.
 */
export function currentStatus(events: TrackingEvent[]): ShipmentStatus | null {
  let latest: { status: ShipmentStatus; occurredAt: Date } | null = null;

  for (const event of events) {
    if (event.status === null) continue;
    if (event.status === "delivered") return "delivered";

    if (latest === null || happenedAfter(event.status, event.occurredAt, latest)) {
      latest = { status: event.status, occurredAt: event.occurredAt };
    }
  }

  return latest?.status ?? null;
}

function happenedAfter(
  status: ShipmentStatus,
  occurredAt: Date,
  other: { status: ShipmentStatus; occurredAt: Date },
): boolean {
  const difference = occurredAt.getTime() - other.occurredAt.getTime();
  if (difference !== 0) return difference > 0;
  return TIE_BREAK_RANK[status] > TIE_BREAK_RANK[other.status];
}
