# shipment-tracking

API que acompanha o produto enviado ao criador. Ela cadastra o código de rastreio em um agregador, busca os eventos e traduz o texto de cada transportadora para cinco status. Ela também indica quando um envio passa do limite de tempo em trânsito.

## Rodar

Use o Node 22.18 ou mais novo.

```bash
npm install
npm test
npm run typecheck
```

Para usar a API, abra dois terminais:

```bash
npm run fake-aggregator
```

```bash
npm start
```

| Variável | Padrão | Função |
| --- | --- | --- |
| `PORT` | `3000` | Porta da API |
| `DATABASE_PATH` | `shipments.db` | Arquivo SQLite |
| `AGGREGATOR_BASE_URL` | `http://localhost:4000` | Endereço do agregador |
| `AGGREGATOR_TIMEOUT_MS` | `5000` | Timeout de cada chamada ao agregador |
| `DELAY_LIMIT_HOURS` | `168` | Limite global de tempo em trânsito |

## API

| Rota | Função |
| --- | --- |
| `POST /shipments` | Cadastra `{ code, carrier, delay_limit_hours? }`. Responde 201 no primeiro cadastro e 200 com o envio existente se o código se repete. |
| `POST /shipments/:id/refresh` | Busca os eventos no agregador e os adiciona ao histórico. |
| `GET /shipments/:id` | Lê o estado local. Não chama o agregador. |
| `GET /shipments` | Lista os envios em páginas. Aceita `delayed`, `limit` e `cursor`. |

A API responde 400 para entrada inválida e 404 para envio inexistente. Ela responde 502 quando o agregador falha, e nesse caso não grava nada.

## Status

Os status são `posted` (postado), `in_transit` (em trânsito), `out_for_delivery` (saiu para entrega), `delivered` (entregue) e `exception` (exceção). O status é `null` até chegar o primeiro evento com tradução.

A API calcula o status atual a partir do histórico completo ([status.ts](src/domain/status.ts)):

- O status atual é o do evento com o maior `occurred_at`. Esse campo é a hora do evento na transportadora. Por isso, um evento antigo que chega depois entra no histórico e não muda o status.
- `delivered` é final. Um evento posterior à entrega entra no histórico e não muda o status.
- Se dois eventos têm o mesmo `occurred_at`, vale esta ordem: `posted`, `in_transit`, `out_for_delivery`, `exception`, `delivered`.
- Um envio pode ir de `exception` para `in_transit` quando o evento `in_transit` é mais novo.

Um status que a transportadora inventou entra no histórico com o texto original e `status: null`. Ele não muda o status atual, e a API registra um aviso no log. A tradução é uma tabela com o texto exato de cada transportadora ([statusMap.ts](src/adapters/aggregator/statusMap.ts)). A tabela não tem valor padrão. O texto "Objeto entregue ao portal interdimensional" não vira `delivered`.

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

A API guarda e devolve o evento assim:

```json
{
  "occurred_at": "2026-10-04T10:40:00.000Z",
  "status": "out_for_delivery",
  "raw_status": "Objeto saiu para entrega ao destinatário",
  "location": "Florianópolis/SC"
}
```

O payload completo está em [examples/raw-payload.json](examples/raw-payload.json). Ele tem eventos fora de ordem, um evento repetido e um status inventado. A resposta completa da API está em [examples/normalized.json](examples/normalized.json). Um teste em [app.test.ts](test/app.test.ts) envia o primeiro arquivo pelo cliente HTTP e compara a resposta com o segundo.

## Atraso

Um envio está atrasado quando estas duas condições são verdadeiras ([delay.ts](src/domain/delay.ts)):

1. O status atual é diferente de `delivered`.
2. O tempo desde o início do trânsito é maior que o limite.

O início do trânsito é o evento `posted` mais antigo. Se não há evento `posted`, é o evento mais antigo do histórico. Um envio sem eventos não tem atraso.

A primeira condição protege a entrega normal. Um envio entregue nunca fica atrasado, em qualquer data de consulta. No limite exato o envio ainda não está atrasado. Um milissegundo depois, está.

O limite vem do campo `delay_limit_hours` do envio. Se o envio não tem esse campo, vale o limite global. Um envio em `exception` continua a contar tempo.

A API calcula o atraso na leitura, com um relógio injetado ([ports.ts](src/domain/ports.ts)). O resultado aparece no campo `is_delayed` e no filtro `?delayed=true`. A API não grava alertas e não envia avisos.

## Listagem

`GET /shipments` devolve `{ items, next_cursor }`, na ordem de criação dos envios. O parâmetro `limit` vai de 1 a 100 e o padrão é 50. Para ler a página seguinte, envie o `next_cursor` no parâmetro `cursor`. Na última página, `next_cursor` é `null`.

O parâmetro `delayed=true` lista só os envios atrasados, e `delayed=false` lista os outros. O banco aplica esse filtro. Para isso, cada envio guarda o início do trânsito e a indicação de entrega. O repositório calcula esses dois valores com as funções do domínio a cada `refresh`. A comparação com o limite existe em dois lugares: em [delay.ts](src/domain/delay.ts) e no SQL de [repository.ts](src/adapters/sqlite/repository.ts). Um teste em [service.test.ts](test/service.test.ts) compara os dois resultados em cada caso de borda.

O índice `(created_at, id)` atende a ordem da listagem. Com 10 mil envios e 200 mil eventos, uma página de 50 envios levou cerca de 1,6 ms. Sem o índice, levou cerca de 2 ms, porque o banco lê e ordena a tabela inteira a cada página. A leitura de todos os envios sem paginação levava cerca de meio segundo.

## Histórico sem duplicar

Cada evento tem uma chave. A chave é o id do agregador, quando ele existe. Sem id, a chave é o horário, o texto e o local do evento. A chave primária `(shipment_id, dedup_key)` do SQLite recusa o evento repetido ([repository.ts](src/adapters/sqlite/repository.ts)). Essa regra vale também para duas consultas ao mesmo tempo.

A API ignora um evento com horário inválido ou sem offset e registra um aviso no log. Os outros eventos da mesma resposta entram no histórico.

## Trocar de agregador

```
src/domain/     regras e portas
src/adapters/   agregador, SQLite e relógio
src/http/       rotas Fastify
dev/            agregador fake para os testes e para uso local
```

O domínio usa três portas ([ports.ts](src/domain/ports.ts)): `TrackingProvider`, `ShipmentRepository` e `Clock`. O `TrackingProvider` devolve eventos no formato do domínio. O formato do agregador só aparece em `src/adapters/aggregator/`. Para trocar de agregador, escreva outra pasta que implemente a porta e mude uma linha em [main.ts](src/main.ts).

Para uma transportadora nova, adicione linhas à tabela de tradução.

## Testes

O comando `npm test` roda 94 testes em 7 arquivos.

| Critério | Arquivos de teste |
| --- | --- |
| Status desconhecido não vira entregue | `service`, `aggregatorClient`, `status` |
| Evento fora de ordem não regride o status | `service`, `status` |
| Consulta repetida não duplica o histórico | `service`, `sqliteRepository` |
| Atraso com data controlada | `delay`, `service`, `app` |
| Agregador trocável | `service` usa um fake da porta; `aggregatorClient` testa o cliente contra um servidor fake |

## Fora de escopo

- Webhook do agregador e consulta agendada
- Envio de aviso por e-mail ou Slack
- Mudança do limite depois do cadastro
- Nova tentativa quando o agregador falha
- Autenticação

## Uso de IA

O Claude Code escreveu o código, os testes e este README.

Eu tomei as decisões de desenho antes do código, uma por uma: status pelo maior `occurred_at`, `delivered` final, status desconhecido sem efeito no status atual, chave única no banco, consulta só sob demanda, atraso calculado na leitura, resposta 502 sem gravação e SQLite embutido. Pedi o limite de atraso por envio e a paginação da listagem com filtro no banco. A ferramenta não recomendou nenhum dos dois. Também propus a organização em portas e adaptadores.

No código, questionei os laços de `status.ts` e `delay.ts`. Perguntei se bastava ler o último e o primeiro evento, porque o histórico vem ordenado. Mantive os dois laços, para o domínio não depender da ordem do repositório. Pedi o `EXPLAIN QUERY PLAN` das queries e a medição de um índice a mais para o histórico. Esse índice não mudou os tempos e não entrou.

Ainda não revisei o resto do código linha por linha.
