import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { RawCheckpoint, RawTracking } from "../src/adapters/aggregator/payload.ts";

interface CannedResponse {
  status: number;
  body: string;
  delayMs?: number;
}

/**
 * Agregador de mentira, em memória. Serve os testes do cliente HTTP e o
 * `npm run fake-aggregator`, para rodar a API na mão.
 */
export class FakeAggregator {
  /** Corpo de cada POST /v1/trackings recebido. */
  readonly registrations: unknown[] = [];
  /** Checkpoints que todo código recém-cadastrado ganha. */
  checkpointsOnRegister: RawCheckpoint[] = [];
  /** Se definida, substitui a próxima resposta, qualquer que seja a rota. */
  nextResponse: CannedResponse | null = null;

  private readonly trackings = new Map<string, RawTracking>();
  private readonly server: Server;

  constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  setTracking(tracking: RawTracking): void {
    this.trackings.set(tracking.tracking_number, tracking);
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

    if (request.method === "POST" && path === "/v1/trackings") {
      const registration = JSON.parse(body) as { tracking_number: string; courier: string };
      this.registrations.push(registration);

      if (this.trackings.has(registration.tracking_number)) {
        return send(response, 409, JSON.stringify({ error: "already_registered" }));
      }
      this.setTracking({ ...registration, checkpoints: this.checkpointsOnRegister });
      return send(response, 201, JSON.stringify({ tracking_number: registration.tracking_number }));
    }

    if (request.method === "GET" && path.startsWith("/v1/trackings/")) {
      const code = decodeURIComponent(path.slice("/v1/trackings/".length));
      const tracking = this.trackings.get(code);

      if (tracking === undefined) return send(response, 404, JSON.stringify({ error: "not_found" }));
      return send(response, 200, JSON.stringify(tracking));
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
