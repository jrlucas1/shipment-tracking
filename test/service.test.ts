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

async function listAll(delayed?: boolean) {
  return (await service.list({ limit: 100, after: null, delayed })).snapshots;
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
    expect(await listAll()).toHaveLength(1);
  });

  it("se a origem recusa, nada é gravado", async () => {
    provider.failure = new TrackingProviderError("down");

    await expect(
      service.register({ code: "BR1", carrier: "correios", delayLimitHours: null }),
    ).rejects.toThrow(TrackingProviderError);

    expect(await listAll()).toEqual([]);
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

    expect((await listAll(true)).map((s) => s.shipment.code)).toEqual(["LATE"]);
    expect((await listAll(false)).map((s) => s.shipment.code)).toEqual(["ONTIME"]);
    expect(await listAll()).toHaveLength(2);
  });
});

describe("list paginada", () => {
  async function registerMany(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await service.register({ code: `BR${i}`, carrier: "correios", delayLimitHours: null });
    }
  }

  async function walk(limit: number, delayed?: boolean): Promise<string[][]> {
    const pages: string[][] = [];
    let after = null;
    do {
      const page = await service.list({ limit, after, delayed });
      pages.push(page.snapshots.map((s) => s.shipment.code));
      after = page.nextCursor;
    } while (after !== null);
    return pages;
  }

  it("sem envios devolve uma página vazia e sem cursor", async () => {
    expect(await service.list({ limit: 10, after: null })).toEqual({ snapshots: [], nextCursor: null });
  });

  it("percorre todos os envios sem repetir nem pular, mesmo criados no mesmo instante", async () => {
    await registerMany(5);

    const pages = await walk(2);

    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(pages.flat().sort()).toEqual(["BR0", "BR1", "BR2", "BR3", "BR4"]);
  });

  it("não devolve cursor quando a última página fica exatamente cheia", async () => {
    await registerMany(4);

    expect((await walk(2)).map((page) => page.length)).toEqual([2, 2]);
  });

  it("segue a ordem de criação", async () => {
    for (const [code, createdAt] of [
      ["PRIMEIRO", "2026-10-01T00:00:00Z"],
      ["SEGUNDO", "2026-10-02T00:00:00Z"],
      ["TERCEIRO", "2026-10-03T00:00:00Z"],
    ] as const) {
      clock.set(createdAt);
      await service.register({ code, carrier: "correios", delayLimitHours: null });
    }

    expect(await walk(2)).toEqual([["PRIMEIRO", "SEGUNDO"], ["TERCEIRO"]]);
  });

  it("com filtro de atraso as páginas vêm cheias, pulando os envios que não entram", async () => {
    await registerMany(6);
    const all = await listAll();
    for (const [index, snapshot] of all.entries()) {
      // Metade entregue, metade só postada.
      provider.events =
        index % 2 === 0
          ? [event("posted", "2026-10-01T12:00:00Z")]
          : [event("posted", "2026-10-01T12:00:00Z"), event("delivered", "2026-10-02T12:00:00Z")];
      await service.refresh(snapshot.shipment.id);
    }
    clock.set("2026-10-10T12:00:00Z");

    expect((await walk(2, true)).map((page) => page.length)).toEqual([2, 1]);
    expect((await walk(2, false)).map((page) => page.length)).toEqual([2, 1]);
    expect((await walk(2, true)).flat().sort()).toEqual(
      all.filter((_, index) => index % 2 === 0).map((s) => s.shipment.code).sort(),
    );
  });

  it("o filtro do banco concorda com isDelayed em cada caso de borda", async () => {
    const POSTED = "2026-10-01T12:00:00Z";
    const histories = {
      SEM_EVENTOS: [],
      SO_POSTADO: [event("posted", POSTED)],
      ENTREGUE: [event("posted", POSTED), event("delivered", "2026-10-02T12:00:00Z")],
      ENTREGUE_E_DEPOIS_EXCECAO: [
        event("posted", POSTED),
        event("delivered", "2026-10-02T12:00:00Z"),
        event("exception", "2026-10-03T12:00:00Z"),
      ],
      EXCECAO: [event("posted", POSTED), event("exception", "2026-10-02T12:00:00Z")],
      SO_DESCONHECIDO: [event(null, POSTED)],
      SEM_POSTAGEM: [event("in_transit", "2026-10-03T12:00:00Z")],
      POSTADO_MAIS_TARDE: [event("posted", "2026-10-03T12:00:00Z")],
    };
    for (const [code, events] of Object.entries(histories)) {
      const { snapshot } = await service.register({ code, carrier: "correios", delayLimitHours: null });
      provider.events = events;
      await service.refresh(snapshot.shipment.id);
    }
    const short = await service.register({ code: "LIMITE_CURTO", carrier: "correios", delayLimitHours: 24 });
    provider.events = [event("posted", POSTED)];
    await service.refresh(short.snapshot.shipment.id);

    // No limite global exato, um milissegundo depois e bem depois.
    for (const now of ["2026-10-02T13:00:00Z", "2026-10-04T12:00:00.000Z", "2026-10-04T12:00:00.001Z", "2026-12-01T00:00:00Z"]) {
      clock.set(now);
      const codes = (snapshots: { shipment: { code: string } }[]) => snapshots.map((s) => s.shipment.code).sort();
      const everything = await listAll();

      expect(codes(await listAll(true)), now).toEqual(codes(everything.filter((s) => s.isDelayed)));
      expect(codes(await listAll(false)), now).toEqual(codes(everything.filter((s) => !s.isDelayed)));
    }

    clock.set("2026-10-04T12:00:00.001Z");
    expect((await listAll(true)).map((s) => s.shipment.code).sort()).toEqual([
      "EXCECAO",
      "LIMITE_CURTO",
      "SO_DESCONHECIDO",
      "SO_POSTADO",
    ]);
  });

  it("evento antigo que chega depois corrige o início do trânsito usado no filtro", async () => {
    const id = await registerShipment();
    provider.events = [event("in_transit", "2026-10-05T12:00:00Z")];
    await service.refresh(id);
    clock.set("2026-10-06T12:00:00Z");
    expect(await listAll(true)).toHaveLength(0);

    provider.events = [event("posted", "2026-10-01T12:00:00Z")];
    await service.refresh(id);

    expect(await listAll(true)).toHaveLength(1);
  });
});
