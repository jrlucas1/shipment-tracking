import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAggregator } from "../dev/fakeAggregator.ts";
import { AggregatorClient } from "../src/adapters/aggregator/client.ts";
import type { RawCheckpoint } from "../src/adapters/aggregator/payload.ts";
import { TrackingProviderError } from "../src/domain/ports.ts";
import { RecordingLogger } from "./support.ts";

let aggregator: FakeAggregator;
let logger: RecordingLogger;
let client: AggregatorClient;

beforeEach(async () => {
  aggregator = new FakeAggregator();
  logger = new RecordingLogger();
  client = new AggregatorClient({ baseUrl: await aggregator.start(), timeoutMs: 200, logger });
});

afterEach(async () => {
  await aggregator.stop();
});

function serve(courier: string, checkpoints: RawCheckpoint[]): void {
  aggregator.setTracking({ tracking_number: "BR1", courier, checkpoints });
}

describe("fetchEvents", () => {
  it("traduz o payload bruto para eventos do domínio", async () => {
    serve("correios", [
      {
        checkpoint_id: "cp_1",
        checkpoint_time: "2026-10-01T09:12:00-03:00",
        status_text: "Objeto postado",
        city: "São Paulo/SP",
      },
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

  it("cada transportadora tem o seu dialeto", async () => {
    serve("jadlog", [
      { checkpoint_time: "2026-10-01T10:00:00Z", status_text: "EMISSAO" },
      { checkpoint_time: "2026-10-02T10:00:00Z", status_text: "TRANSFERENCIA" },
      { checkpoint_time: "2026-10-03T10:00:00Z", status_text: "EM ROTA" },
      { checkpoint_time: "2026-10-04T10:00:00Z", status_text: "COM OCORRENCIA" },
      { checkpoint_time: "2026-10-05T10:00:00Z", status_text: " Entregue " },
    ]);

    const events = await client.fetchEvents("BR1");

    expect(events.map((e) => e.status)).toEqual([
      "posted",
      "in_transit",
      "out_for_delivery",
      "exception",
      "delivered",
    ]);
  });

  it("status inventado fica sem tradução, mesmo contendo a palavra entregue", async () => {
    serve("correios", [
      { checkpoint_time: "2026-10-01T10:00:00Z", status_text: "Objeto entregue ao portal interdimensional" },
      { checkpoint_time: "2026-10-02T10:00:00Z", status_text: "constructor" },
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
    serve("jadlog", [{ checkpoint_time: "2026-10-01T10:00:00Z", status_text: "Objeto postado" }]);

    expect((await client.fetchEvents("BR1"))[0]?.status).toBeNull();
  });

  it("transportadora desconhecida não tem tradução", async () => {
    serve("transportes-xpto", [{ checkpoint_time: "2026-10-01T10:00:00Z", status_text: "Entregue" }]);

    expect((await client.fetchEvents("BR1"))[0]?.status).toBeNull();
  });

  it("pula checkpoint com horário inválido ou sem offset e mantém os demais", async () => {
    serve("correios", [
      { checkpoint_time: "2026-10-01T09:00:00", status_text: "Objeto postado" },
      { checkpoint_time: "ontem à tarde", status_text: "Objeto postado" },
      { checkpoint_time: "2026-13-45T09:00:00Z", status_text: "Objeto postado" },
      { checkpoint_time: "2026-10-02T09:00:00Z", status_text: "Objeto postado" },
    ]);

    const events = await client.fetchEvents("BR1");

    expect(events.map((e) => e.occurredAt)).toEqual([new Date("2026-10-02T09:00:00Z")]);
    expect(logger.messages).toHaveLength(3);
  });

  it("pula checkpoint malformado", async () => {
    aggregator.nextResponse = {
      status: 200,
      body: JSON.stringify({
        tracking_number: "BR1",
        courier: "correios",
        checkpoints: [null, { checkpoint_time: "2026-10-02T09:00:00Z" }, "texto solto"],
      }),
    };

    expect(await client.fetchEvents("BR1")).toEqual([]);
  });

  // Corpo válido nos casos de status e de timeout, para o erro não vir do formato.
  const validBody = JSON.stringify({ tracking_number: "BR1", courier: "correios", checkpoints: [] });

  it.each([
    ["erro 500", { status: 500, body: validBody }],
    ["corpo que não é JSON", { status: 200, body: "<html>" }],
    ["JSON fora do contrato", { status: 200, body: JSON.stringify({ checkpoints: "nenhum" }) }],
    ["JSON null", { status: 200, body: "null" }],
    ["resposta mais lenta que o timeout", { status: 200, body: validBody, delayMs: 600 }],
  ])("%s vira TrackingProviderError", async (_name, response) => {
    serve("correios", []);
    aggregator.nextResponse = response;

    await expect(client.fetchEvents("BR1")).rejects.toThrow(TrackingProviderError);
  });

  it("código que o agregador não conhece vira TrackingProviderError", async () => {
    await expect(client.fetchEvents("NAO-CADASTRADO")).rejects.toThrow(TrackingProviderError);
  });

  it("agregador fora do ar vira TrackingProviderError", async () => {
    await aggregator.stop();

    await expect(client.fetchEvents("BR1")).rejects.toThrow(TrackingProviderError);
  });

  it("código com caracteres especiais vai escapado na URL", async () => {
    aggregator.setTracking({ tracking_number: "BR 1/2?x#y", courier: "correios", checkpoints: [] });

    expect(await client.fetchEvents("BR 1/2?x#y")).toEqual([]);
  });
});

describe("register", () => {
  it("envia código e transportadora no formato do agregador", async () => {
    await client.register("BR1", "correios");

    expect(aggregator.registrations).toEqual([{ tracking_number: "BR1", courier: "correios" }]);
  });

  it("código já cadastrado no agregador não é erro", async () => {
    await client.register("BR1", "correios");

    await expect(client.register("BR1", "correios")).resolves.toBeUndefined();
  });

  it("recusa do agregador vira TrackingProviderError", async () => {
    aggregator.nextResponse = { status: 503, body: "{}" };

    await expect(client.register("BR1", "correios")).rejects.toThrow(TrackingProviderError);
  });
});
