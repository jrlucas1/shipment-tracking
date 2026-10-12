import { describe, expect, it } from "vitest";
import { inTransitSince, isDelayed } from "../src/domain/delay.ts";
import { event } from "./support.ts";

const LIMIT_HOURS = 72;
const POSTED_AT = "2026-10-01T12:00:00Z";
const EXACTLY_AT_LIMIT = new Date("2026-10-04T12:00:00.000Z");
const JUST_PAST_LIMIT = new Date("2026-10-04T12:00:00.001Z");
const MONTHS_LATER = new Date("2027-03-01T00:00:00Z");

describe("isDelayed", () => {
  it("não é atraso exatamente no limite; é um milissegundo depois", () => {
    const events = [event("posted", POSTED_AT), event("in_transit", "2026-10-02T12:00:00Z")];

    expect(isDelayed(events, LIMIT_HOURS, EXACTLY_AT_LIMIT)).toBe(false);
    expect(isDelayed(events, LIMIT_HOURS, JUST_PAST_LIMIT)).toBe(true);
  });

  it("envio entregue não é atraso, mesmo consultado meses depois", () => {
    const events = [event("posted", POSTED_AT), event("delivered", "2026-10-03T12:00:00Z")];

    expect(isDelayed(events, LIMIT_HOURS, MONTHS_LATER)).toBe(false);
  });

  it("envio entregue depois do limite também não fica marcado como atraso", () => {
    const events = [event("posted", POSTED_AT), event("delivered", "2026-10-20T12:00:00Z")];

    expect(isDelayed(events, LIMIT_HOURS, MONTHS_LATER)).toBe(false);
  });

  it("envio em exceção continua contando tempo", () => {
    const events = [event("posted", POSTED_AT), event("exception", "2026-10-02T12:00:00Z")];

    expect(isDelayed(events, LIMIT_HOURS, JUST_PAST_LIMIT)).toBe(true);
  });

  it("sem eventos não há atraso", () => {
    expect(isDelayed([], LIMIT_HOURS, MONTHS_LATER)).toBe(false);
  });

  it("conta da postagem, não do último evento", () => {
    const events = [event("posted", POSTED_AT), event("in_transit", "2026-10-04T11:00:00Z")];

    expect(isDelayed(events, LIMIT_HOURS, JUST_PAST_LIMIT)).toBe(true);
  });

  it("sem evento de postagem conta do evento mais antigo", () => {
    const events = [event("out_for_delivery", "2026-10-03T12:00:00Z"), event("in_transit", POSTED_AT)];

    expect(isDelayed(events, LIMIT_HOURS, EXACTLY_AT_LIMIT)).toBe(false);
    expect(isDelayed(events, LIMIT_HOURS, JUST_PAST_LIMIT)).toBe(true);
  });

  it("postagem que chega fora de ordem ainda é o início da contagem", () => {
    const events = [event("in_transit", "2026-10-03T12:00:00Z"), event("posted", POSTED_AT)];

    expect(inTransitSince(events)).toEqual(new Date(POSTED_AT));
  });

  it("a postagem vale como início mesmo havendo evento sem tradução mais antigo", () => {
    const events = [event(null, "2026-09-30T12:00:00Z"), event("posted", POSTED_AT)];

    expect(inTransitSince(events)).toEqual(new Date(POSTED_AT));
  });
});
