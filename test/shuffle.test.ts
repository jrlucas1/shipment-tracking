import { describe, expect, it } from "vitest";
import { SqliteShipmentRepository } from "../src/adapters/sqlite/repository.ts";
import { delayState, inTransitSince } from "../src/domain/delay.ts";
import { ShipmentService } from "../src/domain/service.ts";
import { currentStatus } from "../src/domain/status.ts";
import type { TrackingEvent } from "../src/domain/types.ts";
import { event, FakeTrackingProvider, FixedClock } from "./support.ts";

const LIMIT_HOURS = 72;
const NOW = new Date("2026-10-10T12:00:00Z");

// Históricos com o que costuma depender de ordem: empate de horário, evento sem
// tradução, entrega no meio, exceção depois da entrega e offsets diferentes.
const HISTORIES: Record<string, TrackingEvent[]> = {
  "fluxo normal": [
    event("posted", "2026-10-01T12:00:00Z"),
    event("in_transit", "2026-10-02T12:00:00Z"),
    event("out_for_delivery", "2026-10-03T12:00:00Z"),
    event("delivered", "2026-10-03T18:00:00Z"),
  ],
  "exceção e volta ao trânsito": [
    event("posted", "2026-10-01T12:00:00Z"),
    event("exception", "2026-10-02T12:00:00Z"),
    event("in_transit", "2026-10-03T12:00:00Z"),
    event(null, "2026-10-04T12:00:00Z"),
  ],
  "empates no mesmo instante": [
    event("posted", "2026-10-01T12:00:00Z"),
    event("in_transit", "2026-10-02T12:00:00Z"),
    event("out_for_delivery", "2026-10-02T12:00:00Z"),
    event("exception", "2026-10-02T12:00:00Z"),
    event(null, "2026-10-02T12:00:00Z"),
  ],
  "evento depois da entrega": [
    event("posted", "2026-10-01T12:00:00Z"),
    event("delivered", "2026-10-06T12:00:00Z"),
    event("exception", "2026-10-07T12:00:00Z"),
    event("in_transit", "2026-10-08T12:00:00Z"),
  ],
  "offsets diferentes e sem postagem": [
    event("in_transit", "2026-10-02T09:00:00-03:00"),
    event("out_for_delivery", "2026-10-02T11:00:00Z"),
    event("in_transit", "2026-10-02T13:30:00+02:00"),
    event(null, "2026-10-01T00:00:00Z"),
  ],
  "duas postagens e duas entregas": [
    event("posted", "2026-10-02T12:00:00Z"),
    event("posted", "2026-10-01T12:00:00Z"),
    event("delivered", "2026-10-09T12:00:00Z"),
    event("delivered", "2026-10-05T12:00:00Z"),
    event("in_transit", "2026-10-03T12:00:00Z"),
  ],
};

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

// Gerador com semente fixa: a mesma sequência de embaralhamentos em toda execução.
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

const summary = (events: TrackingEvent[]) => ({
  status: currentStatus(events),
  delayState: delayState(events, LIMIT_HOURS, NOW),
  inTransitSince: inTransitSince(events),
});

describe("ordem de chegada dos eventos", () => {
  it.each(Object.entries(HISTORIES))("%s: toda permutação dá o mesmo status e o mesmo atraso", (_name, events) => {
    const expected = summary(events);

    for (const order of permutations(events)) {
      expect(summary(order), order.map((e) => e.rawStatus).join(" > ")).toEqual(expected);
    }
  });

  it("os status finais esperados de cada histórico", () => {
    expect(Object.entries(HISTORIES).map(([name, events]) => [name, summary(events).status, summary(events).delayState])).toEqual([
      ["fluxo normal", "delivered", "delivered_on_time"],
      ["exceção e volta ao trânsito", "in_transit", "delayed"],
      ["empates no mesmo instante", "exception", "delayed"],
      ["evento depois da entrega", "delivered", "delivered_late"],
      // 09:00-03:00 é 12:00 UTC, depois das 11:00Z e das 11:30 UTC (13:30+02:00).
      ["offsets diferentes e sem postagem", "in_transit", "delayed"],
      ["duas postagens e duas entregas", "delivered", "delivered_late"],
    ]);
  });

  it.each(Object.entries(HISTORIES))(
    "%s: chegando embaralhado e em lotes, o envio gravado termina igual",
    async (_name, events) => {
      const random = seededRandom(20261012);

      // Consulta o agregador várias vezes; cada resposta traz um pedaço embaralhado
      // do histórico, com repetição do que já tinha chegado.
      async function ingest(order: TrackingEvent[], batchSize: number) {
        const provider = new FakeTrackingProvider();
        const service = new ShipmentService({
          provider,
          repository: new SqliteShipmentRepository(":memory:"),
          clock: new FixedClock(NOW.toISOString()),
          defaultDelayLimitHours: LIMIT_HOURS,
        });
        const { snapshot } = await service.register({ code: "BR1", carrier: "correios", delayLimitHours: null });
        const id = snapshot.shipment.id;
        for (let start = 0; start < order.length; start += batchSize) {
          provider.events = order.slice(Math.max(0, start - 1), start + batchSize);
          await service.refresh(id);
        }
        const final = await service.get(id);
        return {
          status: final.status,
          isDelayed: final.isDelayed,
          delayState: final.delayState,
          inTransitSince: final.inTransitSince,
          deliveredAt: final.deliveredAt,
          events: final.shipment.events,
        };
      }

      const expected = await ingest(events, events.length);
      expect(expected).toMatchObject(summary(events));

      for (let round = 0; round < 40; round++) {
        const order = shuffled(events, random);
        const batchSize = 1 + Math.floor(random() * events.length);
        expect(await ingest(order, batchSize), order.map((e) => e.rawStatus).join(" > ")).toEqual(expected);
      }
    },
  );
});
