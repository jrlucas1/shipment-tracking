import { describe, expect, it } from "vitest";
import { currentStatus } from "../src/domain/status.ts";
import { event } from "./support.ts";

describe("currentStatus", () => {
  it("é null sem eventos", () => {
    expect(currentStatus([])).toBeNull();
  });

  it("vale o evento que aconteceu por último, não o que chegou por último", () => {
    const events = [
      event("out_for_delivery", "2026-10-04T10:00:00Z"),
      event("posted", "2026-10-01T10:00:00Z"),
      event("in_transit", "2026-10-02T10:00:00Z"),
    ];

    expect(currentStatus(events)).toBe("out_for_delivery");
  });

  it("volta de exceção para em trânsito quando o evento é de fato mais novo", () => {
    const events = [
      event("exception", "2026-10-03T10:00:00Z"),
      event("in_transit", "2026-10-04T10:00:00Z"),
    ];

    expect(currentStatus(events)).toBe("in_transit");
  });

  it("status sem tradução não muda o status, mesmo sendo o evento mais novo", () => {
    const events = [
      event("in_transit", "2026-10-02T10:00:00Z"),
      event(null, "2026-10-05T10:00:00Z"),
    ];

    expect(currentStatus(events)).toBe("in_transit");
  });

  it("é null quando só há eventos sem tradução", () => {
    expect(currentStatus([event(null, "2026-10-05T10:00:00Z")])).toBeNull();
  });

  it("entregue é terminal: evento posterior não desfaz a entrega", () => {
    const events = [
      event("delivered", "2026-10-05T10:00:00Z"),
      event("in_transit", "2026-10-06T10:00:00Z"),
      event("exception", "2026-10-07T10:00:00Z"),
    ];

    expect(currentStatus(events)).toBe("delivered");
  });

  it("no mesmo instante vence o status mais adiante no fluxo, em qualquer ordem de chegada", () => {
    const sameInstant = "2026-10-02T10:00:00Z";
    const posted = event("posted", sameInstant);
    const inTransit = event("in_transit", sameInstant);

    expect(currentStatus([posted, inTransit])).toBe("in_transit");
    expect(currentStatus([inTransit, posted])).toBe("in_transit");
  });

  it("no mesmo instante exceção vence saiu para entrega", () => {
    const sameInstant = "2026-10-02T10:00:00Z";
    const events = [event("exception", sameInstant), event("out_for_delivery", sameInstant)];

    expect(currentStatus(events)).toBe("exception");
  });

  it("compara instantes, não o texto do horário com offsets diferentes", () => {
    const events = [
      // 09:00 em São Paulo é 12:00 UTC, depois das 11:00 UTC do outro evento.
      event("out_for_delivery", "2026-10-02T09:00:00-03:00"),
      event("in_transit", "2026-10-02T11:00:00Z"),
    ];

    expect(currentStatus(events)).toBe("out_for_delivery");
  });
});
