import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/http/cursor.ts";

describe("cursor", () => {
  it("decodifica o que codificou", () => {
    const cursor = { createdAt: new Date("2026-10-01T12:00:00.123Z"), id: "abc-123" };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["texto vazio", ""],
    ["texto qualquer", "não é um cursor"],
    ["JSON que não é lista", Buffer.from('{"id":"x"}').toString("base64url")],
    ["lista com tamanho errado", Buffer.from('["2026-10-01T12:00:00Z"]').toString("base64url")],
    ["tipos errados", Buffer.from("[1, 2]").toString("base64url")],
    ["data inválida", Buffer.from('["ontem", "abc"]').toString("base64url")],
  ])("recusa %s", (_name, text) => {
    expect(decodeCursor(text)).toBeNull();
  });
});
