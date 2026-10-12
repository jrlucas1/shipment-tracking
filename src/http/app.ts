import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { TrackingProviderError } from "../domain/ports.ts";
import { ShipmentNotFoundError } from "../domain/service.ts";
import type { ShipmentService, ShipmentSnapshot } from "../domain/service.ts";

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

  app.get<{ Querystring: { delayed?: boolean } }>(
    "/shipments",
    { schema: { querystring: listQuery } },
    async (request) => {
      const snapshots = await service.list({ delayed: request.query.delayed });
      return snapshots.map(toResponse);
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
