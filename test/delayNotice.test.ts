import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteShipmentRepository } from "../src/adapters/sqlite/repository.ts";
import { TrackingProviderError } from "../src/domain/ports.ts";
import type { TrackingProvider } from "../src/domain/ports.ts";
import { ShipmentService } from "../src/domain/service.ts";
import type { TrackingEvent } from "../src/domain/types.ts";
import { buildApp } from "../src/http/app.ts";
import { event, FixedClock } from "./support.ts";

const LIMIT_HOURS = 72;
const POSTED_AT = "2026-10-01T12:00:00Z";
const EXACTLY_AT_LIMIT = "2026-10-04T12:00:00.000Z";
const JUST_PAST_LIMIT = "2026-10-04T12:00:00.001Z";

/** Origem com um histórico por código, que anota cada consulta recebida. */
class ScriptedProvider implements TrackingProvider {
  eventsByCode = new Map<string, TrackingEvent[]>();
  failingCodes = new Set<string>();
  fetched: string[] = [];

  async register(): Promise<void> {}

  async fetchEvents(code: string): Promise<TrackingEvent[]> {
    this.fetched.push(code);
    if (this.failingCodes.has(code)) throw new TrackingProviderError("down");
    return this.eventsByCode.get(code) ?? [];
  }
}

let provider: ScriptedProvider;
let repository: SqliteShipmentRepository;
let clock: FixedClock;
let service: ShipmentService;

beforeEach(() => {
  provider = new ScriptedProvider();
  repository = new SqliteShipmentRepository(":memory:");
  clock = new FixedClock("2026-10-02T12:00:00Z");
  service = new ShipmentService({ provider, repository, clock, defaultDelayLimitHours: LIMIT_HOURS });
});

// Cadastra o envio e traz o histórico dado para o banco local.
async function shipmentWith(code: string, events: TrackingEvent[], delayLimitHours: number | null = null) {
  const { snapshot } = await service.register({ code, carrier: "correios", delayLimitHours });
  provider.eventsByCode.set(code, events);
  await service.refresh(snapshot.shipment.id);
  provider.fetched = [];
  return snapshot.shipment.id;
}

const notifiedAt = async (id: string) => (await service.getDelay(id)).notifiedAt;

describe("job de aviso de atraso", () => {
  it("reconsulta o agregador e grava o aviso do envio atrasado", async () => {
    const id = await shipmentWith("BR1", [event("posted", POSTED_AT)]);
    clock.set("2026-10-05T08:00:00Z");

    const report = await service.notifyDelays();

    expect(report).toEqual({ checked: 1, notified: 1, noLongerDelayed: 0, providerFailures: 0 });
    expect(provider.fetched).toEqual(["BR1"]);
    expect(await notifiedAt(id)).toEqual(new Date("2026-10-05T08:00:00Z"));
  });

  it("rodar de novo não grava outro aviso, não muda a data e não reconsulta o envio já avisado", async () => {
    const id = await shipmentWith("BR1", [event("posted", POSTED_AT)]);
    clock.set("2026-10-05T08:00:00Z");
    await service.notifyDelays();
    provider.fetched = [];

    clock.set("2026-10-06T08:00:00Z");
    const again = await service.notifyDelays();

    expect(again).toEqual({ checked: 0, notified: 0, noLongerDelayed: 0, providerFailures: 0 });
    expect(provider.fetched).toEqual([]);
    expect(await notifiedAt(id)).toEqual(new Date("2026-10-05T08:00:00Z"));
  });

  it("não avisa quando a reconsulta mostra que o envio já foi entregue", async () => {
    const id = await shipmentWith("BR1", [event("posted", POSTED_AT)]);
    clock.set("2026-10-10T08:00:00Z");
    provider.eventsByCode.set("BR1", [event("posted", POSTED_AT), event("delivered", "2026-10-09T12:00:00Z")]);

    const report = await service.notifyDelays();
    const again = await service.notifyDelays();

    expect(report).toEqual({ checked: 1, notified: 0, noLongerDelayed: 1, providerFailures: 0 });
    expect(again.checked).toBe(0);
    expect(await service.getDelay(id)).toMatchObject({ notifiedAt: null, snapshot: { delayState: "delivered_late" } });
  });

  it("limite: no instante exato não avisa nem reconsulta; um milissegundo depois, avisa", async () => {
    const id = await shipmentWith("BR1", [event("posted", POSTED_AT)]);

    clock.set(EXACTLY_AT_LIMIT);
    expect((await service.notifyDelays()).checked).toBe(0);
    expect(provider.fetched).toEqual([]);
    expect(await notifiedAt(id)).toBeNull();

    clock.set(JUST_PAST_LIMIT);
    expect((await service.notifyDelays()).notified).toBe(1);
    expect(await notifiedAt(id)).toEqual(new Date(JUST_PAST_LIMIT));
  });

  it("usa o limite próprio do envio", async () => {
    const short = await shipmentWith("CURTO", [event("posted", POSTED_AT)], 24);
    const normal = await shipmentWith("NORMAL", [event("posted", POSTED_AT)]);
    clock.set("2026-10-03T00:00:00Z");

    await service.notifyDelays();

    expect(await notifiedAt(short)).not.toBeNull();
    expect(await notifiedAt(normal)).toBeNull();
  });

  it("envio sem evento e envio entregue nunca são avisados nem reconsultados", async () => {
    const notPosted = await shipmentWith("SEM-EVENTO", []);
    const delivered = await shipmentWith("ENTREGUE", [event("posted", POSTED_AT), event("delivered", "2026-10-20T12:00:00Z")]);
    clock.set("2027-01-01T00:00:00Z");

    const report = await service.notifyDelays();

    expect(report.checked).toBe(0);
    expect(provider.fetched).toEqual([]);
    expect(await notifiedAt(notPosted)).toBeNull();
    expect(await notifiedAt(delivered)).toBeNull();
  });

  it("agregador fora do ar para um envio: ele fica sem aviso, os outros seguem, e a próxima rodada tenta de novo", async () => {
    const broken = await shipmentWith("QUEBRADO", [event("posted", POSTED_AT)]);
    const fine = await shipmentWith("OK", [event("posted", POSTED_AT)]);
    clock.set("2026-10-05T08:00:00Z");
    provider.failingCodes.add("QUEBRADO");

    const report = await service.notifyDelays();

    expect(report).toEqual({ checked: 2, notified: 1, noLongerDelayed: 0, providerFailures: 1 });
    expect(await notifiedAt(broken)).toBeNull();
    expect(await notifiedAt(fine)).not.toBeNull();

    provider.failingCodes.clear();
    clock.set("2026-10-05T09:00:00Z");
    const retry = await service.notifyDelays();

    expect(retry).toMatchObject({ checked: 1, notified: 1 });
    expect(await notifiedAt(broken)).toEqual(new Date("2026-10-05T09:00:00Z"));
  });

  it("erro que não é do agregador interrompe o job", async () => {
    await shipmentWith("BR1", [event("posted", POSTED_AT)]);
    clock.set("2026-10-05T08:00:00Z");
    provider.fetchEvents = async () => {
      throw new Error("bug");
    };

    await expect(service.notifyDelays()).rejects.toThrow("bug");
  });

  it("duas rodadas ao mesmo tempo gravam um aviso só", async () => {
    const id = await shipmentWith("BR1", [event("posted", POSTED_AT)]);
    clock.set("2026-10-05T08:00:00Z");

    const reports = await Promise.all([service.notifyDelays(), service.notifyDelays()]);

    expect(reports[0].notified + reports[1].notified).toBe(1);
    expect(await notifiedAt(id)).toEqual(new Date("2026-10-05T08:00:00Z"));
  });

  it("percorre todas as páginas de atrasados, cada envio uma vez", async () => {
    const codes = ["A", "B", "C", "D", "E"];
    for (const code of codes) await shipmentWith(code, [event("posted", POSTED_AT)]);
    await shipmentWith("NO-PRAZO", [event("posted", "2026-10-04T12:00:00Z")]);
    clock.set("2026-10-05T08:00:00Z");

    const report = await service.notifyDelays({ pageSize: 2 });

    expect(report).toMatchObject({ checked: 5, notified: 5 });
    expect([...provider.fetched].sort()).toEqual(codes);
  });

  it("o aviso continua lá depois que o envio é entregue", async () => {
    const id = await shipmentWith("BR1", [event("posted", POSTED_AT)]);
    clock.set("2026-10-05T08:00:00Z");
    await service.notifyDelays();

    provider.eventsByCode.set("BR1", [event("posted", POSTED_AT), event("delivered", "2026-10-06T12:00:00Z")]);
    await service.refresh(id);
    clock.set("2026-10-07T08:00:00Z");
    const later = await service.notifyDelays();

    expect(later.checked).toBe(0);
    expect(await service.getDelay(id)).toMatchObject({
      notifiedAt: new Date("2026-10-05T08:00:00Z"),
      snapshot: { delayState: "delivered_late", isDelayed: false },
    });
  });

  it("envio inexistente não tem leitura de atraso", async () => {
    await expect(service.getDelay("nao-existe")).rejects.toThrow("not found");
  });
});

describe("aviso no banco", () => {
  it("o banco aceita um aviso por envio e guarda o primeiro", async () => {
    const id = await shipmentWith("BR1", [event("posted", POSTED_AT)]);

    const first = await repository.recordDelayNotice(id, new Date("2026-10-05T08:00:00Z"));
    const second = await repository.recordDelayNotice(id, new Date("2026-10-06T08:00:00Z"));

    expect([first, second]).toEqual([true, false]);
    expect(await repository.findDelayNotice(id)).toEqual(new Date("2026-10-05T08:00:00Z"));
  });

  it("o aviso de um envio não vale para outro", async () => {
    const one = await shipmentWith("BR1", [event("posted", POSTED_AT)]);
    const other = await shipmentWith("BR2", [event("posted", POSTED_AT)]);

    await repository.recordDelayNotice(one, new Date("2026-10-05T08:00:00Z"));

    expect(await repository.findDelayNotice(other)).toBeNull();
  });

  it("o aviso continua gravado depois de reabrir o arquivo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shipments-"));
    try {
      const path = join(dir, "shipments.db");
      const first = new SqliteShipmentRepository(path);
      const shipment = await first.create({ code: "BR1", carrier: "correios", delayLimitHours: null, createdAt: new Date(POSTED_AT) });
      await first.recordDelayNotice(shipment.id, new Date("2026-10-05T08:00:00Z"));
      first.close();

      const reopened = new SqliteShipmentRepository(path);
      expect(await reopened.findDelayNotice(shipment.id)).toEqual(new Date("2026-10-05T08:00:00Z"));
      expect(await reopened.recordDelayNotice(shipment.id, new Date("2026-10-09T08:00:00Z"))).toBe(false);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /shipments/:id/delay com aviso", () => {
  it("mostra quando o aviso foi gravado", async () => {
    const id = await shipmentWith("BR1", [event("posted", POSTED_AT)]);
    const app = buildApp(service);
    const read = async () => (await app.inject({ method: "GET", url: `/shipments/${id}/delay` })).json();

    clock.set("2026-10-05T08:00:00Z");
    expect((await read()).notified_at).toBeNull();

    await service.notifyDelays();

    expect(await read()).toEqual({
      state: "delayed",
      delay_limit_hours: LIMIT_HOURS,
      in_transit_since: "2026-10-01T12:00:00.000Z",
      delivered_at: null,
      notified_at: "2026-10-05T08:00:00.000Z",
    });
  });
});
