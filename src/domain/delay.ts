import { currentStatus } from "./status.ts";
import type { TrackingEvent } from "./types.ts";

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Início da contagem do tempo em trânsito: a postagem mais antiga ou, se a
 * transportadora nunca informou postagem, o evento mais antigo conhecido.
 */
export function inTransitSince(events: TrackingEvent[]): Date | null {
  const posted = events.filter((event) => event.status === "posted");
  return earliest(posted) ?? earliest(events);
}

/**
 * Atrasado é o envio que ainda não foi entregue e está em trânsito há mais tempo
 * que o limite. Envio entregue nunca é atrasado, não importa quando se pergunta.
 */
export function isDelayed(events: TrackingEvent[], limitHours: number, now: Date): boolean {
  if (currentStatus(events) === "delivered") return false;

  const since = inTransitSince(events);
  if (since === null) return false;

  return now.getTime() - since.getTime() > limitHours * MS_PER_HOUR;
}

function earliest(events: TrackingEvent[]): Date | null {
  let result: Date | null = null;
  for (const event of events) {
    if (result === null || event.occurredAt < result) result = event.occurredAt;
  }
  return result;
}
