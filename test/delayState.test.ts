import { describe, expect, it } from "vitest";
import { deliveredAt, delayState, isDelayed } from "../src/domain/delay.ts";
import { event } from "./support.ts";

const LIMIT_HOURS = 72;
const POSTED_AT = "2026-10-01T12:00:00Z";
const EXACTLY_AT_LIMIT = "2026-10-04T12:00:00.000Z";
const JUST_PAST_LIMIT = "2026-10-04T12:00:00.001Z";
const MONTHS_LATER = new Date("2027-03-01T00:00:00Z");

describe("delayState", () => {
  it("sem eventos o envio ainda não foi postado, em qualquer data", () => {
    expect(delayState([], LIMIT_HOURS, MONTHS_LATER)).toBe("not_posted");
  });

  it("em trânsito: no prazo exatamente no limite, atrasado um milissegundo depois", () => {
    const events = [event("posted", POSTED_AT), event("in_transit", "2026-10-02T12:00:00Z")];

    expect(delayState(events, LIMIT_HOURS, new Date(EXACTLY_AT_LIMIT))).toBe("on_time");
    expect(delayState(events, LIMIT_HOURS, new Date(JUST_PAST_LIMIT))).toBe("delayed");
  });

  it("o relógio para na entrega: entregue no limite exato é no prazo; um milissegundo depois, com atraso", () => {
    const onTime = [event("posted", POSTED_AT), event("delivered", EXACTLY_AT_LIMIT)];
    const late = [event("posted", POSTED_AT), event("delivered", JUST_PAST_LIMIT)];

    expect(delayState(onTime, LIMIT_HOURS, MONTHS_LATER)).toBe("delivered_on_time");
    expect(delayState(late, LIMIT_HOURS, MONTHS_LATER)).toBe("delivered_late");
  });

  it("a data da consulta não muda o estado de um envio entregue", () => {
    const onTime = [event("posted", POSTED_AT), event("delivered", "2026-10-03T12:00:00Z")];
    const late = [event("posted", POSTED_AT), event("delivered", "2026-10-20T12:00:00Z")];

    for (const now of ["2026-10-03T12:00:00Z", "2026-10-25T00:00:00Z", "2027-03-01T00:00:00Z"]) {
      expect(delayState(onTime, LIMIT_HOURS, new Date(now)), now).toBe("delivered_on_time");
      expect(delayState(late, LIMIT_HOURS, new Date(now)), now).toBe("delivered_late");
    }
  });

  it("entregue com atraso não é atrasado: isDelayed continua falso", () => {
    const late = [event("posted", POSTED_AT), event("delivered", "2026-10-20T12:00:00Z")];

    expect(delayState(late, LIMIT_HOURS, MONTHS_LATER)).toBe("delivered_late");
    expect(isDelayed(late, LIMIT_HOURS, MONTHS_LATER)).toBe(false);
  });

  it("isDelayed é verdadeiro só no estado delayed", () => {
    const inTransit = [event("posted", POSTED_AT)];

    expect(isDelayed(inTransit, LIMIT_HOURS, new Date(EXACTLY_AT_LIMIT))).toBe(false);
    expect(isDelayed(inTransit, LIMIT_HOURS, new Date(JUST_PAST_LIMIT))).toBe(true);
    expect(isDelayed([], LIMIT_HOURS, MONTHS_LATER)).toBe(false);
  });

  it("evento posterior à entrega não religa o relógio", () => {
    const events = [
      event("posted", POSTED_AT),
      event("delivered", "2026-10-03T12:00:00Z"),
      event("exception", "2026-10-30T12:00:00Z"),
    ];

    expect(delayState(events, LIMIT_HOURS, MONTHS_LATER)).toBe("delivered_on_time");
  });

  it("com duas entregas no histórico o relógio para na primeira", () => {
    const events = [
      event("delivered", "2026-10-20T12:00:00Z"),
      event("posted", POSTED_AT),
      event("delivered", "2026-10-03T12:00:00Z"),
    ];

    expect(deliveredAt(events)).toEqual(new Date("2026-10-03T12:00:00Z"));
    expect(delayState(events, LIMIT_HOURS, MONTHS_LATER)).toBe("delivered_on_time");
  });

  it("entrega sem postagem conta do evento mais antigo", () => {
    const late = [event("in_transit", POSTED_AT), event("delivered", JUST_PAST_LIMIT)];
    const onlyDelivery = [event("delivered", "2026-10-20T12:00:00Z")];

    expect(delayState(late, LIMIT_HOURS, MONTHS_LATER)).toBe("delivered_late");
    expect(delayState(onlyDelivery, LIMIT_HOURS, MONTHS_LATER)).toBe("delivered_on_time");
  });

  it("compara instantes: entrega com offset de São Paulo", () => {
    // 09:00:00.001-03:00 é 12:00:00.001Z, um milissegundo depois do limite.
    const events = [event("posted", POSTED_AT), event("delivered", "2026-10-04T09:00:00.001-03:00")];

    expect(delayState(events, LIMIT_HOURS, MONTHS_LATER)).toBe("delivered_late");
  });

  it("deliveredAt é null enquanto não há entrega", () => {
    expect(deliveredAt([event("posted", POSTED_AT), event("exception", "2026-10-02T12:00:00Z")])).toBeNull();
  });
});
