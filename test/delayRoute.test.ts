import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteShipmentRepository } from "../src/adapters/sqlite/repository.ts";
import { ShipmentService } from "../src/domain/service.ts";
import { buildApp } from "../src/http/app.ts";
import type { TrackingEvent } from "../src/domain/types.ts";
import { event, FakeTrackingProvider, FixedClock } from "./support.ts";

const POSTED_AT = "2026-10-01T12:00:00Z";

let provider: FakeTrackingProvider;
let clock: FixedClock;
let app: FastifyInstance;

beforeEach(() => {
  provider = new FakeTrackingProvider();
  clock = new FixedClock("2026-10-02T12:00:00Z");
  app = buildApp(
    new ShipmentService({
      provider,
      repository: new SqliteShipmentRepository(":memory:"),
      clock,
      defaultDelayLimitHours: 72,
    }),
  );
});

// Cadastra um envio com o histórico dado e devolve a leitura do atraso.
async function delayOf(events: TrackingEvent[], payload: Record<string, unknown> = {}) {
  const created = await app.inject({
    method: "POST",
    url: "/shipments",
    payload: { code: "BR1", carrier: "correios", ...payload },
  });
  const { id } = created.json();
  provider.events = events;
  await app.inject({ method: "POST", url: `/shipments/${id}/refresh` });
  return async () => (await app.inject({ method: "GET", url: `/shipments/${id}/delay` })).json();
}

describe("GET /shipments/:id/delay", () => {
  it("envio sem evento ainda não foi postado", async () => {
    const read = await delayOf([]);
    clock.set("2027-01-01T00:00:00Z");

    expect(await read()).toEqual({
      state: "not_posted",
      delay_limit_hours: 72,
      in_transit_since: null,
      delivered_at: null,
    });
  });

  it("em trânsito vira atrasado quando passa do limite", async () => {
    const read = await delayOf([event("posted", POSTED_AT)]);

    clock.set("2026-10-04T12:00:00.000Z");
    expect((await read()).state).toBe("on_time");

    clock.set("2026-10-04T12:00:00.001Z");
    expect(await read()).toEqual({
      state: "delayed",
      delay_limit_hours: 72,
      in_transit_since: "2026-10-01T12:00:00.000Z",
      delivered_at: null,
    });
  });

  it("entregue depois do limite é entregue com atraso, e o envio não aparece como atrasado", async () => {
    const read = await delayOf([event("posted", POSTED_AT), event("delivered", "2026-10-06T12:00:00Z")]);
    clock.set("2026-12-01T00:00:00Z");

    expect(await read()).toEqual({
      state: "delivered_late",
      delay_limit_hours: 72,
      in_transit_since: "2026-10-01T12:00:00.000Z",
      delivered_at: "2026-10-06T12:00:00.000Z",
    });
    const delayed = await app.inject({ method: "GET", url: "/shipments?delayed=true" });
    expect(delayed.json().items).toEqual([]);
  });

  it("entregue dentro do limite é entregue no prazo, consultado meses depois", async () => {
    const read = await delayOf([event("posted", POSTED_AT), event("delivered", "2026-10-03T12:00:00Z")]);
    clock.set("2027-03-01T00:00:00Z");

    expect((await read()).state).toBe("delivered_on_time");
  });

  it("usa o limite próprio do envio", async () => {
    const read = await delayOf(
      [event("posted", POSTED_AT), event("delivered", "2026-10-03T12:00:00Z")],
      { delay_limit_hours: 24 },
    );

    expect(await read()).toMatchObject({ state: "delivered_late", delay_limit_hours: 24 });
  });

  it("envio inexistente responde 404", async () => {
    const response = await app.inject({ method: "GET", url: "/shipments/nao-existe/delay" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "shipment_not_found" });
  });
});
