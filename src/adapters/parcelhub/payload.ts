// Formato bruto do ParcelHub, o segundo agregador. Nada fora desta pasta importa este arquivo.
//
// Difere do primeiro agregador em tudo que é formato: o cadastro é um PUT
// idempotente, a resposta vem dentro de `data`, o horário é epoch em
// milissegundos e o local vem separado em cidade e estado.

export interface RawParcelEvent {
  uid?: string | null;
  /** Epoch em milissegundos, UTC. */
  at_ms: number;
  /** Texto livre, no dialeto da transportadora. */
  description: string;
  place?: { city: string; state?: string | null } | null;
}

export interface RawParcel {
  data: {
    code: string;
    carrier: string;
    history: RawParcelEvent[];
  };
}

/** Confere só a casca do payload; cada evento é validado na tradução. */
export function parseRawParcel(body: unknown): { carrier: string; history: unknown[] } | null {
  if (typeof body !== "object" || body === null) return null;

  const { data } = body as Record<string, unknown>;
  if (typeof data !== "object" || data === null) return null;

  const { carrier, history } = data as Record<string, unknown>;
  if (typeof carrier !== "string" || !Array.isArray(history)) return null;

  return { carrier, history };
}
