# shipment-tracking

API que acompanha o produto enviado ao criador. Ela cadastra o código de rastreio em um agregador, busca os eventos e traduz o texto de cada transportadora para cinco status. Ela também indica quando um envio passa do limite de tempo em trânsito.

## Rodar

Use o Node 22.18 ou mais novo.

```bash
npm install
npm test
npm run typecheck
```

Para usar a API, rode `npm run fake-aggregator` em um terminal e `npm start` em outro. As variáveis `PORT`, `DATABASE_PATH`, `AGGREGATOR_BASE_URL`, `AGGREGATOR_TIMEOUT_MS` e `DELAY_LIMIT_HOURS` têm os padrões de [config.ts](src/config.ts). O limite global de trânsito é de 168 horas. `npm run delay-job` roda uma vez o job de aviso de atraso, com as mesmas variáveis.

## API

| Rota | Função |
| --- | --- |
| `POST /shipments` | Cadastra `{ code, carrier, delay_limit_hours? }`. Um código repetido devolve o envio existente. |
| `POST /shipments/:id/refresh` | Busca os eventos no agregador e os adiciona ao histórico. |
| `GET /shipments/:id` | Lê o estado local. Não chama o agregador. |
| `GET /shipments/:id/delay` | Lê o estado do atraso (`not_posted`, `on_time`, `delayed`, `delivered_on_time`, `delivered_late`) e quando o aviso foi gravado. |
| `GET /shipments` | Lista os envios em páginas. Aceita `delayed`, `limit` e `cursor`. |

Quando o agregador falha, a API responde 502 e não grava nada.

## Status

Os status são `posted`, `in_transit`, `out_for_delivery`, `delivered` e `exception`. A API calcula o status atual a partir do histórico completo ([status.ts](src/domain/status.ts)):

- O status atual é o do evento com o maior `occurred_at`, a hora do evento na transportadora. Um evento antigo que chega depois entra no histórico e não muda o status.
- `delivered` é final.
- Um status que a transportadora inventou entra no histórico com `status: null` e não muda o status atual. A tradução é uma tabela com o texto exato de cada transportadora, sem valor padrão ([statusMap.ts](src/adapters/aggregator/statusMap.ts)).

## Exemplo

O agregador envia cada evento neste formato:

```json
{
  "checkpoint_id": "cp_4",
  "checkpoint_time": "2026-10-04T07:40:00-03:00",
  "status_text": "Objeto saiu para entrega ao destinatário",
  "city": "Florianópolis/SC"
}
```

A API devolve o evento assim:

```json
{
  "occurred_at": "2026-10-04T10:40:00.000Z",
  "status": "out_for_delivery",
  "raw_status": "Objeto saiu para entrega ao destinatário",
  "location": "Florianópolis/SC"
}
```

O payload completo está em [raw-payload.json](examples/raw-payload.json) e a resposta completa em [normalized.json](examples/normalized.json). Um teste compara os dois arquivos.

## Atraso

Um envio está atrasado quando estas duas condições são verdadeiras ([delay.ts](src/domain/delay.ts)):

1. O status atual é diferente de `delivered`.
2. O tempo desde o evento `posted` é maior que o limite.

A primeira condição protege a entrega normal: um envio entregue nunca fica atrasado, em qualquer data de consulta. Sem evento `posted`, a contagem começa no evento mais antigo. O limite vem do campo `delay_limit_hours` do envio ou, sem ele, do limite global.

A API calcula o atraso na leitura, com um relógio injetado. O resultado aparece no campo `is_delayed` e no filtro `?delayed=true`. O relógio para na entrega: o envio entregue depois do limite fica `delivered_late`, que é diferente de `delayed`. A API não envia avisos. O job grava um aviso por envio atrasado, depois de reconsultar o agregador, e nunca grava o segundo.

## Histórico e listagem

Cada evento tem uma chave: o id do agregador ou, sem id, o horário, o texto e o local. A chave primária `(shipment_id, dedup_key)` do SQLite recusa o evento repetido.

`GET /shipments` devolve `{ items, next_cursor }` na ordem de criação, com `limit` de 1 a 100. O banco aplica o filtro `delayed` e usa o índice `(created_at, id)`. Com 200 mil eventos, uma página de 50 envios levou cerca de 1,6 ms.

## Trocar de agregador

O domínio usa três portas ([ports.ts](src/domain/ports.ts)): `TrackingProvider`, `ShipmentRepository` e `Clock`. O formato de cada agregador só aparece na pasta dele: `src/adapters/aggregator/` e `src/adapters/parcelhub/`, um segundo agregador com outro formato. Os dois passam no mesmo contrato de testes. Para trocar de agregador, mude uma linha em [main.ts](src/main.ts). Para uma transportadora nova, adicione linhas à tabela de tradução.

## Fora de escopo

Webhook, agendamento do job, envio do aviso gravado, mudança do limite depois do cadastro, nova tentativa, autenticação e migração de schema.

## Uso de IA

O Claude Code escreveu o código, os testes e este README.

Eu tomei as decisões de desenho antes do código: status pelo maior `occurred_at`, `delivered` final, status desconhecido sem efeito, chave única no banco, consulta sob demanda, atraso calculado na leitura e resposta 502 sem gravação. Pedi o limite por envio e a paginação com filtro no banco, que a ferramenta não recomendou. Também propus a organização em portas e adaptadores.

Li por inteiro `src/adapters/sqlite/repository.ts` e `test/app.test.ts`. Questionei os laços de `status.ts` e `delay.ts` e mantive os dois. Pedi o `EXPLAIN QUERY PLAN` das queries. Perguntei sobre o timeout e a validação do payload no cliente do agregador, a tabela de tradução, o cursor da listagem e as portas de `ports.ts`. Ainda não li os outros arquivos por inteiro.
