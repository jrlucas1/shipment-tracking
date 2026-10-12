import example from "../examples/raw-payload.json" with { type: "json" };
import { FakeAggregator } from "./fakeAggregator.ts";

// Todo código cadastrado responde com os checkpoints do exemplo: fora de ordem,
// com um repetido e um status inventado.
const aggregator = new FakeAggregator();
aggregator.checkpointsOnRegister = example.checkpoints;

const baseUrl = await aggregator.start(Number(process.env.FAKE_AGGREGATOR_PORT ?? 4000));
console.log(`agregador fake em ${baseUrl}`);
