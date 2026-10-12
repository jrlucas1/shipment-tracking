import { beforeEach, describe, expect, it } from "vitest";
import { SqliteShipmentRepository } from "../src/adapters/sqlite/repository.ts";
import { TrackingProviderError } from "../src/domain/ports.ts";
import { ShipmentNotFoundError, ShipmentService } from "../src/domain/service.ts";
import { event, FakeTrackingProvider, FixedClock } from "./support.ts";

const GLOBAL_LIMIT_HOURS = 72;

let provider: FakeTrackingProvider;
let repository: SqliteShipmentRepository;
let clock: FixedClock;
let service: ShipmentService;

beforeEach(() => {
  provider = new FakeTrackingProvider();
  repository = new SqliteShipmentRepository(":memory:");
  clock = new FixedClock("2026-10-02T12:00:00Z");
  service = new ShipmentService({
    provider,
    repository,
    clock,
    defaultDelayLimitHours: GLOBAL_LIMIT_HOURS,
  });
});

async function registerShipment(delayLimitHours: number | null = null): Promise<string> {
  const { snapshot } = await service.register({ code: "BR1", carrier: "correios", delayLimitHours });
  return snapshot.shipment.id;
}

describe("register", () => {
  it("cadastra na origem e localmente, sem status ainda", async () => {
    const { snapshot, created } = await service.register({
      code: "BR1",
      carrier: "correios",
      delayLimitHours: null,
    });

    expect(created).toBe(true);
    expect(provider.registered).toEqual(["BR1"]);
    expect(snapshot.status).toBeNull();
    expect(snapshot.isDelayed).toBe(false);
  });

  it("código repetido devolve o mesmo envio e não chama a origem de novo", async () => {
    const first = await service.register({ code: "BR1", carrier: "correios", delayLimitHours: null });
    const second = await service.register({ code: "BR1", carrier: "jadlog", delayLimitHours: 5 });

    expect(second.created).toBe(false);
    expect(second.snapshot.shipment).toEqual(first.snapshot.shipment);
    expect(provider.registered).toEqual(["BR1"]);
    expect(await service.list()).toHaveLength(1);
  });

  it("se a origem recusa, nada é gravado", async () => {
    provider.failure = new TrackingProviderError("down");

    await expect(
      service.register({ code: "BR1", carrier: "correios", delayLimitHours: null }),
    ).rejects.toThrow(TrackingProviderError);

    expect(await service.list()).toEqual([]);
  });
});

describe("refresh", () => {
  it("evento antigo que chega depois não regride o status", async () => {
    const id = await registerShipment();

    provider.events = [event("out_for_delivery", "2026-10-02T09:00:00Z")];
    expect((await service.refresh(id)).status).toBe("out_for_delivery");

    provider.events = [event("posted", "2026-10-01T09:00:00Z"), event("in_transit", "2026-10-01T18:00:00Z")];
    const snapshot = await service.refresh(id);

    expect(snapshot.status).toBe("out_for_delivery");
    expect(snapshot.shipment.events.map((e) => e.status)).toEqual(["posted", "in_transit", "out_for_delivery"]);
  });

  it("status que a transportadora inventou entra no histórico e não vira entregue", async () => {
    const id = await registerShipment();
    provider.events = [
      event("in_transit", "2026-10-01T09:00:00Z"),
      event(null, "2026-10-02T09:00:00Z", { rawStatus: "Objeto entregue ao portal interdimensional" }),
    ];

    const snapshot = await service.refresh(id);

    expect(snapshot.status).toBe("in_transit");
    expect(snapshot.shipment.events).toHaveLength(2);
    expect(snapshot.shipment.events[1]).toMatchObject({
      status: null,
      rawStatus: "Objeto entregue ao portal interdimensional",
    });
  });

  it("consultar de novo o mesmo código não duplica o histórico", async () => {
    const id = await registerShipment();
    provider.events = [
      event("posted", "2026-10-01T09:00:00Z", { externalId: "cp_1" }),
      event("in_transit", "2026-10-01T18:00:00Z"),
    ];

    await service.refresh(id);
    await service.refresh(id);
    const snapshot = await service.refresh(id);

    expect(snapshot.shipment.events).toHaveLength(2);
  });

  it("evento repetido dentro da mesma resposta entra uma vez só", async () => {
    const id = await registerShipment();
    const posted = event("posted", "2026-10-01T09:00:00Z");
    provider.events = [posted, { ...posted }];

    expect((await service.refresh(id)).shipment.events).toHaveLength(1);
  });

  it("falha da origem deixa o histórico como estava", async () => {
    const id = await registerShipment();
    provider.events = [event("posted", "2026-10-01T09:00:00Z")];
    await service.refresh(id);

    provider.failure = new TrackingProviderError("timeout");
    await expect(service.refresh(id)).rejects.toThrow(TrackingProviderError);

    const snapshot = await service.get(id);
    expect(snapshot.status).toBe("posted");
    expect(snapshot.shipment.events).toHaveLength(1);
  });

  it("envio inexistente é erro próprio", async () => {
    await expect(service.refresh("nao-existe")).rejects.toThrow(ShipmentNotFoundError);
    await expect(service.get("nao-existe")).rejects.toThrow(ShipmentNotFoundError);
  });
});

describe("atraso", () => {
  const POSTED_AT = "2026-10-01T12:00:00Z";

  it("usa o limite global e o relógio injetado", async () => {
    const id = await registerShipment();
    provider.events = [event("posted", POSTED_AT)];
    await service.refresh(id);

    clock.set("2026-10-04T12:00:00.000Z");
    expect((await service.get(id)).isDelayed).toBe(false);

    clock.set("2026-10-04T12:00:00.001Z");
    const snapshot = await service.get(id);
    expect(snapshot.isDelayed).toBe(true);
    expect(snapshot.delayLimitHours).toBe(GLOBAL_LIMIT_HOURS);
  });

  it("o limite do envio vale no lugar do global", async () => {
    const id = await registerShipment(24);
    provider.events = [event("posted", POSTED_AT)];
    await service.refresh(id);

    clock.set("2026-10-02T12:00:00.001Z");
    const snapshot = await service.get(id);

    expect(snapshot.isDelayed).toBe(true);
    expect(snapshot.delayLimitHours).toBe(24);
  });

  it("deixa de ser atraso quando a entrega chega", async () => {
    const id = await registerShipment();
    provider.events = [event("posted", POSTED_AT)];
    await service.refresh(id);
    clock.set("2026-10-10T12:00:00Z");
    expect((await service.get(id)).isDelayed).toBe(true);

    provider.events = [event("delivered", "2026-10-09T12:00:00Z")];
    expect((await service.refresh(id)).isDelayed).toBe(false);
  });

  it("list filtra por atrasados e por não atrasados", async () => {
    const late = await service.register({ code: "LATE", carrier: "correios", delayLimitHours: null });
    const onTime = await service.register({ code: "ONTIME", carrier: "correios", delayLimitHours: null });

    provider.events = [event("posted", POSTED_AT)];
    await service.refresh(late.snapshot.shipment.id);
    provider.events = [event("posted", POSTED_AT), event("delivered", "2026-10-02T12:00:00Z")];
    await service.refresh(onTime.snapshot.shipment.id);

    clock.set("2026-10-10T12:00:00Z");

    expect((await service.list({ delayed: true })).map((s) => s.shipment.code)).toEqual(["LATE"]);
    expect((await service.list({ delayed: false })).map((s) => s.shipment.code)).toEqual(["ONTIME"]);
    expect(await service.list()).toHaveLength(2);
  });
});
