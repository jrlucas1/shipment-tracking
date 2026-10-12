import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAggregator } from "../dev/fakeAggregator.ts";
import normalizedExample from "../examples/normalized.json" with { type: "json" };
import rawExample from "../examples/raw-payload.json" with { type: "json" };
import { AggregatorClient } from "../src/adapters/aggregator/client.ts";
import { SqliteShipmentRepository } from "../src/adapters/sqlite/repository.ts";
import { TrackingProviderError } from "../src/domain/ports.ts";
import { ShipmentService } from "../src/domain/service.ts";
import { buildApp } from "../src/http/app.ts";
import { event, FakeTrackingProvider, FixedClock, RecordingLogger } from "./support.ts";

describe("rotas", () => {
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

  async function register(payload: Record<string, unknown> = { code: "BR1", carrier: "correios" }) {
    return app.inject({ method: "POST", url: "/shipments", payload });
  }

  it("POST /shipments cria com 201 e repete com 200", async () => {
    const first = await register();
    const second = await register();

    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({
      id: expect.any(String),
      code: "BR1",
      carrier: "correios",
      status: null,
      is_delayed: false,
      delay_limit_hours: 72,
      in_transit_since: null,
      events: [],
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it("POST /shipments aceita limite próprio", async () => {
    const response = await register({ code: "BR1", carrier: "correios", delay_limit_hours: 24 });

    expect(response.statusCode).toBe(201);
    expect(response.json().delay_limit_hours).toBe(24);
  });

  it.each([
    ["sem código", { carrier: "correios" }],
    ["sem transportadora", { code: "BR1" }],
    ["código vazio", { code: "", carrier: "correios" }],
    ["limite zero", { code: "BR1", carrier: "correios", delay_limit_hours: 0 }],
    ["limite negativo", { code: "BR1", carrier: "correios", delay_limit_hours: -5 }],
    ["limite fracionário", { code: "BR1", carrier: "correios", delay_limit_hours: 1.5 }],
    ["limite que não é número", { code: "BR1", carrier: "correios", delay_limit_hours: "muito" }],
  ])("POST /shipments recusa %s com 400 e não cadastra", async (_name, payload) => {
    const response = await register(payload);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
    expect(provider.registered).toEqual([]);
  });

  it("POST /shipments responde 502 quando a origem falha", async () => {
    provider.failure = new TrackingProviderError("down");

    const response = await register();

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "tracking_provider_unavailable" });
    expect((await app.inject({ method: "GET", url: "/shipments" })).json()).toEqual([]);
  });

  it("refresh ingere, GET lê o estado local sem chamar a origem", async () => {
    const { id } = (await register()).json();
    provider.events = [event("posted", "2026-10-01T09:00:00Z", { location: "São Paulo/SP" })];

    const refreshed = await app.inject({ method: "POST", url: `/shipments/${id}/refresh` });
    provider.failure = new TrackingProviderError("down");
    const read = await app.inject({ method: "GET", url: `/shipments/${id}` });

    expect(refreshed.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(refreshed.json());
    expect(read.json()).toMatchObject({
      status: "posted",
      in_transit_since: "2026-10-01T09:00:00.000Z",
      events: [
        {
          occurred_at: "2026-10-01T09:00:00.000Z",
          status: "posted",
          raw_status: "posted",
          location: "São Paulo/SP",
        },
      ],
    });
  });

  it("refresh responde 502 quando a origem falha", async () => {
    const { id } = (await register()).json();
    provider.failure = new TrackingProviderError("down");

    const response = await app.inject({ method: "POST", url: `/shipments/${id}/refresh` });

    expect(response.statusCode).toBe(502);
  });

  it("envio inexistente responde 404", async () => {
    const read = await app.inject({ method: "GET", url: "/shipments/nao-existe" });
    const refreshed = await app.inject({ method: "POST", url: "/shipments/nao-existe/refresh" });

    expect(read.statusCode).toBe(404);
    expect(read.json()).toEqual({ error: "shipment_not_found" });
    expect(refreshed.statusCode).toBe(404);
  });

  it("GET /shipments?delayed filtra pelo atraso calculado na leitura", async () => {
    const { id } = (await register()).json();
    provider.events = [event("posted", "2026-10-01T12:00:00Z")];
    await app.inject({ method: "POST", url: `/shipments/${id}/refresh` });

    const codes = async (url: string) =>
      (await app.inject({ method: "GET", url })).json().map((s: { code: string }) => s.code);

    expect(await codes("/shipments?delayed=true")).toEqual([]);
    expect(await codes("/shipments?delayed=false")).toEqual(["BR1"]);

    clock.set("2026-10-04T12:00:00.001Z");

    expect(await codes("/shipments?delayed=true")).toEqual(["BR1"]);
    expect(await codes("/shipments?delayed=false")).toEqual([]);
    expect(await codes("/shipments")).toEqual(["BR1"]);
  });

  it("GET /shipments recusa filtro que não é booleano", async () => {
    const response = await app.inject({ method: "GET", url: "/shipments?delayed=talvez" });

    expect(response.statusCode).toBe(400);
  });
});

describe("exemplo do README, de ponta a ponta", () => {
  let aggregator: FakeAggregator;

  beforeEach(() => {
    aggregator = new FakeAggregator();
  });

  afterEach(async () => {
    await aggregator.stop();
  });

  it("examples/raw-payload.json normaliza para examples/normalized.json", async () => {
    aggregator.checkpointsOnRegister = rawExample.checkpoints;
    const app = buildApp(
      new ShipmentService({
        provider: new AggregatorClient({
          baseUrl: await aggregator.start(),
          timeoutMs: 1000,
          logger: new RecordingLogger(),
        }),
        repository: new SqliteShipmentRepository(":memory:"),
        clock: new FixedClock("2026-10-05T12:00:00Z"),
        defaultDelayLimitHours: 168,
      }),
    );

    const created = await app.inject({
      method: "POST",
      url: "/shipments",
      payload: { code: rawExample.tracking_number, carrier: rawExample.courier },
    });
    const { id } = created.json();
    await app.inject({ method: "POST", url: `/shipments/${id}/refresh` });
    const refreshed = await app.inject({ method: "POST", url: `/shipments/${id}/refresh` });

    expect(refreshed.json()).toEqual({ ...normalizedExample, id });
  });
});
