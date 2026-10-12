import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { TrackingProviderError } from "../domain/ports.ts";
import { ShipmentNotFoundError } from "../domain/service.ts";
import type { ShipmentService, ShipmentSnapshot } from "../domain/service.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";

const registerBody = {
  type: "object",
  required: ["code", "carrier"],
  additionalProperties: false,
  properties: {
    code: { type: "string", minLength: 1 },
    carrier: { type: "string", minLength: 1 },
    delay_limit_hours: { type: "integer", minimum: 1 },
  },
} as const;

const listQuery = {
  type: "object",
  properties: {
    delayed: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    cursor: { type: "string" },
  },
} as const;

export function buildApp(service: ShipmentService, options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ShipmentNotFoundError) {
      return reply.status(404).send({ error: "shipment_not_found" });
    }
    if (error instanceof TrackingProviderError) {
      app.log.warn({ err: error }, "falha ao consultar o agregador");
      return reply.status(502).send({ error: "tracking_provider_unavailable" });
    }
    if (isValidationError(error)) {
      return reply.status(400).send({ error: "invalid_request", message: error.message });
    }
    app.log.error({ err: error }, "erro inesperado");
    return reply.status(500).send({ error: "internal_error" });
  });

  app.post<{ Body: { code: string; carrier: string; delay_limit_hours?: number } }>(
    "/shipments",
    { schema: { body: registerBody } },
    async (request, reply) => {
      const { snapshot, created } = await service.register({
        code: request.body.code,
        carrier: request.body.carrier,
        delayLimitHours: request.body.delay_limit_hours ?? null,
      });
      return reply.status(created ? 201 : 200).send(toResponse(snapshot));
    },
  );

  app.post<{ Params: { id: string } }>("/shipments/:id/refresh", async (request) => {
    return toResponse(await service.refresh(request.params.id));
  });

  app.get<{ Params: { id: string } }>("/shipments/:id", async (request) => {
    return toResponse(await service.get(request.params.id));
  });

  // Fica numa rota própria para a resposta do envio continuar como está.
  app.get<{ Params: { id: string } }>("/shipments/:id/delay", async (request) => {
    const { snapshot, notifiedAt } = await service.getDelay(request.params.id);
    return {
      state: snapshot.delayState,
      delay_limit_hours: snapshot.delayLimitHours,
      in_transit_since: snapshot.inTransitSince?.toISOString() ?? null,
      delivered_at: snapshot.deliveredAt?.toISOString() ?? null,
      // Quando o job gravou o aviso de atraso deste envio; `null` se nunca gravou.
      notified_at: notifiedAt?.toISOString() ?? null,
    };
  });

  app.get<{ Querystring: { delayed?: boolean; limit: number; cursor?: string } }>(
    "/shipments",
    { schema: { querystring: listQuery } },
    async (request, reply) => {
      const { delayed, limit, cursor } = request.query;

      const after = cursor === undefined ? null : decodeCursor(cursor);
      if (cursor !== undefined && after === null) {
        return reply.status(400).send({ error: "invalid_request", message: "cursor is not valid" });
      }

      const { snapshots, nextCursor } = await service.list({ delayed, limit, after });
      return {
        items: snapshots.map(toResponse),
        next_cursor: nextCursor === null ? null : encodeCursor(nextCursor),
      };
    },
  );

  return app;
}

function isValidationError(error: unknown): error is Error {
  return error instanceof Error && "validation" in error;
}

function toResponse(snapshot: ShipmentSnapshot) {
  const { shipment } = snapshot;
  return {
    id: shipment.id,
    code: shipment.code,
    carrier: shipment.carrier,
    status: snapshot.status,
    is_delayed: snapshot.isDelayed,
    delay_limit_hours: snapshot.delayLimitHours,
    in_transit_since: snapshot.inTransitSince?.toISOString() ?? null,
    events: shipment.events.map((event) => ({
      occurred_at: event.occurredAt.toISOString(),
      status: event.status,
      raw_status: event.rawStatus,
      location: event.location,
    })),
  };
}
