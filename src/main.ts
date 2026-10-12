import { AggregatorClient } from "./adapters/aggregator/client.ts";
import { SqliteShipmentRepository } from "./adapters/sqlite/repository.ts";
import { systemClock } from "./adapters/systemClock.ts";
import { loadConfig } from "./config.ts";
import { ShipmentService } from "./domain/service.ts";
import { buildApp } from "./http/app.ts";

const config = loadConfig(process.env);

// O app é criado depois do serviço, mas o cliente do agregador precisa do log dele.
const logger = {
  warn: (context: Record<string, unknown>, message: string) => app.log.warn(context, message),
};

const service = new ShipmentService({
  provider: new AggregatorClient({
    baseUrl: config.aggregatorBaseUrl,
    timeoutMs: config.aggregatorTimeoutMs,
    logger,
  }),
  repository: new SqliteShipmentRepository(config.databasePath),
  clock: systemClock,
  defaultDelayLimitHours: config.delayLimitHours,
});

const app = buildApp(service, { logger: true });

await app.listen({ port: config.port, host: "127.0.0.1" });
