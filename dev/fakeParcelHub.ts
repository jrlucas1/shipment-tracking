import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { RawParcelEvent } from "../src/adapters/parcelhub/payload.ts";

interface CannedResponse {
  status: number;
  body: string;
  delayMs?: number;
}

/** ParcelHub de mentira, em memória. Serve os testes do segundo adaptador. */
export class FakeParcelHub {
  /** Código e transportadora de cada PUT /api/parcels/:code recebido. */
  readonly registrations: { code: string; carrier: string }[] = [];
  /** Histórico que todo código recém-cadastrado ganha. */
  historyOnRegister: RawParcelEvent[] = [];
  /** Se definida, substitui a próxima resposta, qualquer que seja a rota. */
  nextResponse: CannedResponse | null = null;

  private readonly parcels = new Map<string, { carrier: string; history: RawParcelEvent[] }>();
  private readonly server: Server;

  constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  setParcel(code: string, carrier: string, history: RawParcelEvent[]): void {
    this.parcels.set(code, { carrier, history });
  }

  /** Sobe o servidor e devolve a URL base. Porta 0 escolhe uma porta livre. */
  async start(port = 0): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(port, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);

    if (this.nextResponse !== null) {
      const canned = this.nextResponse;
      this.nextResponse = null;
      if (canned.delayMs !== undefined) await sleep(canned.delayMs);
      return send(response, canned.status, canned.body);
    }

    const path = new URL(request.url ?? "/", "http://fake").pathname;
    if (!path.startsWith("/api/parcels/")) return send(response, 404, JSON.stringify({ error: "not_found" }));
    const code = decodeURIComponent(path.slice("/api/parcels/".length));

    if (request.method === "PUT") {
      const { carrier } = JSON.parse(body) as { carrier: string };
      this.registrations.push({ code, carrier });

      if (this.parcels.has(code)) return send(response, 200, JSON.stringify({ data: { code } }));
      this.setParcel(code, carrier, this.historyOnRegister);
      return send(response, 201, JSON.stringify({ data: { code } }));
    }

    if (request.method === "GET") {
      const parcel = this.parcels.get(code);
      if (parcel === undefined) return send(response, 404, JSON.stringify({ error: "not_found" }));
      return send(response, 200, JSON.stringify({ data: { code, ...parcel } }));
    }

    return send(response, 404, JSON.stringify({ error: "not_found" }));
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
