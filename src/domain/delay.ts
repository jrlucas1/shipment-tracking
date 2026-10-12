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

/** Quando o envio foi entregue: a entrega mais antiga do histórico. `null` se não foi. */
export function deliveredAt(events: TrackingEvent[]): Date | null {
  return earliest(events.filter((event) => event.status === "delivered"));
}

export type DelayState = "not_posted" | "on_time" | "delayed" | "delivered_on_time" | "delivered_late";

/**
 * O relógio do trânsito começa em `inTransitSince` e para na entrega. Enquanto o
 * envio não é entregue, o tempo conta até `now`: passou do limite, está atrasado.
 * Depois da entrega o tempo é fixo, da postagem até a entrega: passou do limite,
 * foi entregue com atraso, e isso não muda com a data da consulta.
 */
export function delayState(events: TrackingEvent[], limitHours: number, now: Date): DelayState {
  const since = inTransitSince(events);
  if (since === null) return "not_posted";

  const limitMs = limitHours * MS_PER_HOUR;
  const delivered = deliveredAt(events);
  if (delivered !== null) {
    return delivered.getTime() - since.getTime() > limitMs ? "delivered_late" : "delivered_on_time";
  }
  return now.getTime() - since.getTime() > limitMs ? "delayed" : "on_time";
}

/**
 * Atrasado é o envio que ainda não foi entregue e está em trânsito há mais tempo
 * que o limite. Envio entregue nunca é atrasado, não importa quando se pergunta.
 */
export function isDelayed(events: TrackingEvent[], limitHours: number, now: Date): boolean {
  return delayState(events, limitHours, now) === "delayed";
}

function earliest(events: TrackingEvent[]): Date | null {
  let result: Date | null = null;
  for (const event of events) {
    if (result === null || event.occurredAt < result) result = event.occurredAt;
  }
  return result;
}
