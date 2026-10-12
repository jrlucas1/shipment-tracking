import { beforeEach, describe, expect, it } from "vitest";
import { SqliteShipmentRepository } from "../src/adapters/sqlite/repository.ts";
import type { Shipment } from "../src/domain/types.ts";
import { event } from "./support.ts";

let repository: SqliteShipmentRepository;
let shipment: Shipment;

beforeEach(async () => {
  repository = new SqliteShipmentRepository(":memory:");
  shipment = await repository.create({
    code: "BR1",
    carrier: "correios",
    delayLimitHours: 48,
    createdAt: new Date("2026-10-01T00:00:00Z"),
  });
});

async function listAll() {
  return repository.list({ limit: 100, after: null, now: new Date(0), defaultDelayLimitHours: 72 });
}

async function storedEvents() {
  return (await repository.findById(shipment.id))?.events ?? [];
}

describe("SqliteShipmentRepository", () => {
  it("guarda e lê o envio por id e por código", async () => {
    expect(shipment).toMatchObject({
      code: "BR1",
      carrier: "correios",
      delayLimitHours: 48,
      createdAt: new Date("2026-10-01T00:00:00Z"),
      events: [],
    });
    expect(await repository.findById(shipment.id)).toEqual(shipment);
    expect(await repository.findByCode("BR1")).toEqual(shipment);
    expect(await repository.findById("nao-existe")).toBeNull();
    expect(await repository.findByCode("nao-existe")).toBeNull();
  });

  it("criar um código que já existe devolve o envio original", async () => {
    const again = await repository.create({
      code: "BR1",
      carrier: "jadlog",
      delayLimitHours: null,
      createdAt: new Date("2026-10-05T00:00:00Z"),
    });

    expect(again).toEqual(shipment);
    expect(await listAll()).toHaveLength(1);
  });

  it("mesmo id externo entra uma vez, ainda que o resto do evento mude", async () => {
    await repository.addEvents(shipment.id, [event("posted", "2026-10-01T09:00:00Z", { externalId: "cp_1" })]);
    await repository.addEvents(shipment.id, [event("posted", "2026-10-01T09:30:00Z", { externalId: "cp_1" })]);

    expect(await storedEvents()).toHaveLength(1);
  });

  it("sem id externo, o evento é identificado por horário, texto e local", async () => {
    const base = event("in_transit", "2026-10-02T09:00:00Z", { location: "Cajamar/SP" });

    await repository.addEvents(shipment.id, [base]);
    await repository.addEvents(shipment.id, [
      { ...base },
      { ...base, location: "Curitiba/PR" },
      { ...base, occurredAt: new Date("2026-10-02T09:00:01Z") },
      { ...base, rawStatus: "outro texto" },
    ]);

    expect(await storedEvents()).toHaveLength(4);
  });

  it("o mesmo evento em envios diferentes não colide", async () => {
    const other = await repository.create({
      code: "BR2",
      carrier: "correios",
      delayLimitHours: null,
      createdAt: new Date("2026-10-01T00:00:00Z"),
    });
    const posted = event("posted", "2026-10-01T09:00:00Z", { externalId: "cp_1" });

    await repository.addEvents(shipment.id, [posted]);
    await repository.addEvents(other.id, [posted]);

    expect(await storedEvents()).toHaveLength(1);
    expect((await repository.findById(other.id))?.events).toHaveLength(1);
  });

  it("devolve o histórico em ordem de acontecimento, com os campos intactos", async () => {
    const delivery = event("out_for_delivery", "2026-10-04T10:40:00Z", { externalId: "cp_4", location: "Florianópolis/SC" });
    const unknown = event(null, "2026-10-03T11:05:00Z", { rawStatus: "desembaraço lunar" });
    const posted = event("posted", "2026-10-01T12:12:00Z");

    await repository.addEvents(shipment.id, [delivery, unknown, posted]);

    expect(await storedEvents()).toEqual([posted, unknown, delivery]);
  });

  it("list respeita limit e continua depois do cursor", async () => {
    for (const day of [2, 3, 4]) {
      await repository.create({
        code: `BR${day}`,
        carrier: "correios",
        delayLimitHours: null,
        createdAt: new Date(`2026-10-0${day}T00:00:00Z`),
      });
    }
    const query = { limit: 2, now: new Date(0), defaultDelayLimitHours: 72 };

    const first = await repository.list({ ...query, after: null });
    const last = first[1];
    const second = await repository.list({ ...query, after: { createdAt: last!.createdAt, id: last!.id } });

    expect(first.map((s) => s.code)).toEqual(["BR1", "BR2"]);
    expect(second.map((s) => s.code)).toEqual(["BR3", "BR4"]);
  });

  it("list devolve cada envio com o seu histórico", async () => {
    const other = await repository.create({
      code: "BR2",
      carrier: "loggi",
      delayLimitHours: null,
      createdAt: new Date("2026-10-02T00:00:00Z"),
    });
    await repository.addEvents(shipment.id, [event("posted", "2026-10-01T09:00:00Z")]);
    await repository.addEvents(other.id, [
      event("in_transit", "2026-10-03T09:00:00Z"),
      event("posted", "2026-10-02T09:00:00Z"),
    ]);

    const listed = await listAll();

    expect(listed.map((s) => [s.code, s.events.map((e) => e.status)])).toEqual([
      ["BR1", ["posted"]],
      ["BR2", ["posted", "in_transit"]],
    ]);
  });
});
