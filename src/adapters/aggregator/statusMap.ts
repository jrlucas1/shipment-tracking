import type { ShipmentStatus } from "../../domain/types.ts";

// Uma entrada por texto conhecido de cada transportadora. Transportadora nova ou
// texto novo entram aqui. Não há valor padrão: o que não está na tabela não tem
// tradução, e nunca é adivinhado por semelhança.
const STATUS_BY_CARRIER: Record<string, Record<string, ShipmentStatus>> = {
  correios: {
    "objeto postado": "posted",
    "objeto em transferência - por favor aguarde": "in_transit",
    "objeto saiu para entrega ao destinatário": "out_for_delivery",
    "objeto entregue ao destinatário": "delivered",
    "objeto não entregue - endereço incorreto": "exception",
    "objeto não entregue - carteiro não atendido": "exception",
  },
  jadlog: {
    emissao: "posted",
    transferencia: "in_transit",
    "em rota": "out_for_delivery",
    entregue: "delivered",
    "com ocorrencia": "exception",
  },
  loggi: {
    "pacote coletado": "posted",
    "em trânsito": "in_transit",
    "saiu para entrega": "out_for_delivery",
    "pacote entregue": "delivered",
    "problema na entrega": "exception",
  },
};

export function translateStatus(carrier: string, statusText: string): ShipmentStatus | null {
  const known = STATUS_BY_CARRIER[normalize(carrier)];
  if (known === undefined) return null;

  // Object.hasOwn evita que textos como "constructor" casem com herança do objeto.
  const text = normalize(statusText);
  return Object.hasOwn(known, text) ? (known[text] ?? null) : null;
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}
