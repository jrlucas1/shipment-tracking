// Formato bruto do agregador. Nada fora desta pasta importa este arquivo.

export interface RawCheckpoint {
  checkpoint_id?: string | null;
  /** ISO 8601 com offset, por exemplo "2026-10-01T09:12:00-03:00". */
  checkpoint_time: string;
  /** Texto livre, no dialeto da transportadora. */
  status_text: string;
  city?: string | null;
}

export interface RawTracking {
  tracking_number: string;
  courier: string;
  checkpoints: RawCheckpoint[];
}

/** Confere só a casca do payload; cada checkpoint é validado na tradução. */
export function parseRawTracking(body: unknown): { courier: string; checkpoints: unknown[] } | null {
  if (typeof body !== "object" || body === null) return null;

  const { courier, checkpoints } = body as Record<string, unknown>;
  if (typeof courier !== "string" || !Array.isArray(checkpoints)) return null;

  return { courier, checkpoints };
}
