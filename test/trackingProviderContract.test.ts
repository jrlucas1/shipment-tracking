import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAggregator } from "../dev/fakeAggregator.ts";
import { FakeParcelHub } from "../dev/fakeParcelHub.ts";
import normalizedExample from "../examples/normalized.json" with { type: "json" };
import parcelHubExample from "../examples/raw-payload-parcelhub.json" with { type: "json" };
import aggregatorExample from "../examples/raw-payload.json" with { type: "json" };
import { AggregatorClient } from "../src/adapters/aggregator/client.ts";
import { ParcelHubClient } from "../src/adapters/parcelhub/client.ts";
import { SqliteShipmentRepository } from "../src/adapters/sqlite/repository.ts";
import { TrackingProviderError } from "../src/domain/ports.ts";
import type { TrackingProvider } from "../src/domain/ports.ts";
import { ShipmentService } from "../src/domain/service.ts";
import { buildApp } from "../src/http/app.ts";
import { FixedClock, RecordingLogger } from "./support.ts";

/** Um evento como a transportadora o emite, antes de qualquer agregador dar formato a ele. */
interface CarrierEvent {
  id?: string;
  at: string;
  text: string;
  city?: string;
  state?: string;
}

interface CannedResponse {
  status: number;
  body: string;
  delayMs?: number;
}

/** O que muda de um agregador para outro: o servidor de mentira e o formato do payload. */
interface Harness {
  start(logger: RecordingLogger): Promise<TrackingProvider>;
  stop(): Promise<void>;
  /** Faz o agregador responder com estes eventos para o código. */
  serve(code: string, carrier: string, events: CarrierEvent[]): void;
  respondNext(response: CannedResponse): void;
  /** Corpo de uma resposta 200 com o histórico dado, já no formato do agregador. */
  body(carrier: string, history: unknown[]): string;
  /** Um evento válido no formato do agregador, com os campos trocados por `overrides`. */
  rawEvent(overrides: Record<string, unknown>): Record<string, unknown>;
  /** Nome do campo de horário e valores que o adaptador precisa recusar. */
  timeField: string;
  invalidTimes: unknown[];
  outOfContractBody: string;
  registrations(): { code: string; carrier: string }[];
  /** O payload do exemplo do README neste formato. */
  exampleHistory: unknown[];
  serveOnRegister(history: unknown[]): void;
}

function aggregatorHarness(): Harness {
  const fake = new FakeAggregator();
  const toRaw = (event: CarrierEvent) => ({
    ...(event.id === undefined ? {} : { checkpoint_id: event.id }),
    checkpoint_time: event.at,
    status_text: event.text,
    ...(event.city === undefined ? {} : { city: `${event.city}/${event.state}` }),
  });
  return {
    start: async (logger) => new AggregatorClient({ baseUrl: await fake.start(), timeoutMs: 200, logger }),
    stop: () => fake.stop(),
    serve: (code, carrier, events) =>
      fake.setTracking({ tracking_number: code, courier: carrier, checkpoints: events.map(toRaw) }),
    respondNext: (response) => {
      fake.nextResponse = response;
    },
    body: (carrier, history) => JSON.stringify({ tracking_number: "BR1", courier: carrier, checkpoints: history }),
    rawEvent: (overrides) => ({ checkpoint_time: "2026-10-02T09:00:00Z", status_text: "Objeto postado", ...overrides }),
    timeField: "checkpoint_time",
    invalidTimes: ["2026-10-01T09:00:00", "ontem à tarde", "2026-13-45T09:00:00Z", 1790856720000, null],
    outOfContractBody: JSON.stringify({ checkpoints: "nenhum" }),
    registrations: () =>
      (fake.registrations as { tracking_number: string; courier: string }[]).map((r) => ({
        code: r.tracking_number,
        carrier: r.courier,
      })),
    exampleHistory: aggregatorExample.checkpoints,
    serveOnRegister: (history) => {
      fake.checkpointsOnRegister = history as typeof fake.checkpointsOnRegister;
    },
  };
}

function parcelHubHarness(): Harness {
  const fake = new FakeParcelHub();
  const toRaw = (event: CarrierEvent) => ({
    ...(event.id === undefined ? {} : { uid: event.id }),
    at_ms: Date.parse(event.at),
    description: event.text,
    ...(event.city === undefined ? {} : { place: { city: event.city, state: event.state } }),
  });
  return {
    start: async (logger) => new ParcelHubClient({ baseUrl: await fake.start(), timeoutMs: 200, logger }),
    stop: () => fake.stop(),
    serve: (code, carrier, events) => fake.setParcel(code, carrier, events.map(toRaw)),
    respondNext: (response) => {
      fake.nextResponse = response;
    },
    body: (carrier, history) => JSON.stringify({ data: { code: "BR1", carrier, history } }),
    rawEvent: (overrides) => ({ at_ms: Date.parse("2026-10-02T09:00:00Z"), description: "Objeto postado", ...overrides }),
    timeField: "at_ms",
    invalidTimes: ["2026-10-01T09:00:00Z", "1790856720000", 1790856720000.5, 8.64e15 + 1, Number.NaN, null],
    outOfContractBody: JSON.stringify({ data: { history: "nenhum" } }),
    registrations: () => fake.registrations,
    exampleHistory: parcelHubExample.data.history,
    serveOnRegister: (history) => {
      fake.historyOnRegister = history as typeof fake.historyOnRegister;
    },
  };
}

const ADAPTERS: [string, () => Harness][] = [
  ["AggregatorClient", aggregatorHarness],
  ["ParcelHubClient", parcelHubHarness],
];

describe.each(ADAPTERS)("contrato do TrackingProvider (%s)", (_name, createHarness) => {
  let harness: Harness;
  let logger: RecordingLogger;
  let client: TrackingProvider;

  beforeEach(async () => {
    harness = createHarness();
    logger = new RecordingLogger();
    client = await harness.start(logger);
  });

  afterEach(async () => {
    await harness.stop();
  });

  describe("fetchEvents", () => {
    it("traduz o payload bruto para eventos do domínio", async () => {
      harness.serve("BR1", "correios", [
        { id: "cp_1", at: "2026-10-01T09:12:00-03:00", text: "Objeto postado", city: "São Paulo", state: "SP" },
      ]);

      expect(await client.fetchEvents("BR1")).toEqual([
        {
          externalId: "cp_1",
          occurredAt: new Date("2026-10-01T12:12:00Z"),
          status: "posted",
          rawStatus: "Objeto postado",
          location: "São Paulo/SP",
        },
      ]);
    });

    it("evento sem id e sem local vem com os dois nulos", async () => {
      harness.serve("BR1", "correios", [{ at: "2026-10-01T12:00:00Z", text: "Objeto postado" }]);

      expect(await client.fetchEvents("BR1")).toEqual([
        {
          externalId: null,
          occurredAt: new Date("2026-10-01T12:00:00Z"),
          status: "posted",
          rawStatus: "Objeto postado",
          location: null,
        },
      ]);
    });

    it("cada transportadora tem o seu dialeto", async () => {
      harness.serve("BR1", "jadlog", [
        { at: "2026-10-01T10:00:00Z", text: "EMISSAO" },
        { at: "2026-10-02T10:00:00Z", text: "TRANSFERENCIA" },
        { at: "2026-10-03T10:00:00Z", text: "EM ROTA" },
        { at: "2026-10-04T10:00:00Z", text: "COM OCORRENCIA" },
        { at: "2026-10-05T10:00:00Z", text: " Entregue " },
      ]);

      const events = await client.fetchEvents("BR1");

      expect(events.map((e) => e.status)).toEqual(["posted", "in_transit", "out_for_delivery", "exception", "delivered"]);
    });

    it("status inventado fica sem tradução, mesmo contendo a palavra entregue", async () => {
      harness.serve("BR1", "correios", [
        { at: "2026-10-01T10:00:00Z", text: "Objeto entregue ao portal interdimensional" },
        { at: "2026-10-02T10:00:00Z", text: "constructor" },
      ]);

      const events = await client.fetchEvents("BR1");

      expect(events.map((e) => e.status)).toEqual([null, null]);
      expect(events[0]?.rawStatus).toBe("Objeto entregue ao portal interdimensional");
      expect(logger.messages).toEqual([
        "status da transportadora sem tradução",
        "status da transportadora sem tradução",
      ]);
    });

    it("o texto de uma transportadora não vale para outra", async () => {
      harness.serve("BR1", "jadlog", [{ at: "2026-10-01T10:00:00Z", text: "Objeto postado" }]);

      expect((await client.fetchEvents("BR1"))[0]?.status).toBeNull();
    });

    it("transportadora desconhecida não tem tradução", async () => {
      harness.serve("BR1", "transportes-xpto", [{ at: "2026-10-01T10:00:00Z", text: "Entregue" }]);

      expect((await client.fetchEvents("BR1"))[0]?.status).toBeNull();
    });

    it("mantém a ordem em que o agregador mandou, sem reordenar nem tirar repetido", async () => {
      harness.serve("BR1", "correios", [
        { id: "b", at: "2026-10-03T10:00:00Z", text: "Objeto postado" },
        { id: "a", at: "2026-10-01T10:00:00Z", text: "Objeto postado" },
        { id: "a", at: "2026-10-01T10:00:00Z", text: "Objeto postado" },
      ]);

      expect((await client.fetchEvents("BR1")).map((e) => e.externalId)).toEqual(["b", "a", "a"]);
    });

    it("pula evento com horário inválido e mantém os demais", async () => {
      const invalid = harness.invalidTimes.map((time) => harness.rawEvent({ [harness.timeField]: time }));
      harness.respondNext({ status: 200, body: harness.body("correios", [...invalid, harness.rawEvent({})]) });

      const events = await client.fetchEvents("BR1");

      expect(events.map((e) => e.occurredAt)).toEqual([new Date("2026-10-02T09:00:00Z")]);
      expect(logger.messages).toHaveLength(harness.invalidTimes.length);
    });

    it("pula evento malformado", async () => {
      const withoutText = { [harness.timeField]: harness.rawEvent({})[harness.timeField] };
      harness.respondNext({ status: 200, body: harness.body("correios", [null, withoutText, "texto solto"]) });

      expect(await client.fetchEvents("BR1")).toEqual([]);
    });

    it.each([
      ["erro 500", (h: Harness) => ({ status: 500, body: h.body("correios", []) })],
      ["corpo que não é JSON", () => ({ status: 200, body: "<html>" })],
      ["JSON fora do contrato", (h: Harness) => ({ status: 200, body: h.outOfContractBody })],
      ["JSON null", () => ({ status: 200, body: "null" })],
      ["resposta mais lenta que o timeout", (h: Harness) => ({ status: 200, body: h.body("correios", []), delayMs: 600 })],
    ])("%s vira TrackingProviderError", async (_case, response) => {
      harness.serve("BR1", "correios", []);
      harness.respondNext(response(harness));

      await expect(client.fetchEvents("BR1")).rejects.toThrow(TrackingProviderError);
    });

    it("código que o agregador não conhece vira TrackingProviderError", async () => {
      await expect(client.fetchEvents("NAO-CADASTRADO")).rejects.toThrow(TrackingProviderError);
    });

    it("agregador fora do ar vira TrackingProviderError", async () => {
      await harness.stop();

      await expect(client.fetchEvents("BR1")).rejects.toThrow(TrackingProviderError);
    });

    it("código com caracteres especiais vai escapado na URL", async () => {
      harness.serve("BR 1/2?x#y", "correios", []);

      expect(await client.fetchEvents("BR 1/2?x#y")).toEqual([]);
    });
  });

  describe("register", () => {
    it("envia código e transportadora", async () => {
      await client.register("BR1", "correios");

      expect(harness.registrations()).toEqual([{ code: "BR1", carrier: "correios" }]);
    });

    it("código já cadastrado no agregador não é erro", async () => {
      await client.register("BR1", "correios");

      await expect(client.register("BR1", "correios")).resolves.toBeUndefined();
    });

    it("recusa do agregador vira TrackingProviderError", async () => {
      harness.respondNext({ status: 503, body: "{}" });

      await expect(client.register("BR1", "correios")).rejects.toThrow(TrackingProviderError);
    });

    it("agregador fora do ar no cadastro vira TrackingProviderError", async () => {
      await harness.stop();

      await expect(client.register("BR1", "correios")).rejects.toThrow(TrackingProviderError);
    });
  });

  it("o exemplo do README neste formato normaliza para o mesmo examples/normalized.json", async () => {
    harness.serveOnRegister(harness.exampleHistory);
    const app = buildApp(
      new ShipmentService({
        provider: client,
        repository: new SqliteShipmentRepository(":memory:"),
        clock: new FixedClock("2026-10-05T12:00:00Z"),
        defaultDelayLimitHours: 168,
      }),
    );

    const created = await app.inject({
      method: "POST",
      url: "/shipments",
      payload: { code: normalizedExample.code, carrier: normalizedExample.carrier },
    });
    const { id } = created.json();
    await app.inject({ method: "POST", url: `/shipments/${id}/refresh` });
    const refreshed = await app.inject({ method: "POST", url: `/shipments/${id}/refresh` });

    expect(refreshed.json()).toEqual({ ...normalizedExample, id });
  });
});
