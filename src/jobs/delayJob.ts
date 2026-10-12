import { AggregatorClient } from "../adapters/aggregator/client.ts";
import { SqliteShipmentRepository } from "../adapters/sqlite/repository.ts";
import { systemClock } from "../adapters/systemClock.ts";
import { loadConfig } from "../config.ts";
import { ShipmentService } from "../domain/service.ts";

// Uma rodada do job de aviso de atraso, para ser chamada por um agendador
// externo (cron). Usa o mesmo banco e as mesmas variáveis da API.
const config = loadConfig(process.env);
const repository = new SqliteShipmentRepository(config.databasePath);

const service = new ShipmentService({
  provider: new AggregatorClient({
    baseUrl: config.aggregatorBaseUrl,
    timeoutMs: config.aggregatorTimeoutMs,
    logger: { warn: (context, message) => console.warn(message, context) },
  }),
  repository,
  clock: systemClock,
  defaultDelayLimitHours: config.delayLimitHours,
});

console.log(JSON.stringify(await service.notifyDelays()));
repository.close();
