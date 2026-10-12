import type { PageCursor } from "../domain/types.ts";

// O cursor é opaco para quem chama: a posição (createdAt, id) em base64url.

export function encodeCursor(cursor: PageCursor): string {
  const position = [cursor.createdAt.toISOString(), cursor.id];
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

/** Devolve `null` se o texto não é um cursor emitido por `encodeCursor`. */
export function decodeCursor(text: string): PageCursor | null {
  let position: unknown;
  try {
    position = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!Array.isArray(position) || position.length !== 2) return null;

  const [createdAt, id] = position as unknown[];
  if (typeof createdAt !== "string" || typeof id !== "string") return null;

  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;

  return { createdAt: date, id };
}
