# shipment-tracking

API que acompanha o produto enviado ao criador. Cadastra um código de rastreio num agregador, consulta os eventos, traduz o dialeto de cada transportadora para cinco status e diz quando o envio passou do tempo de trânsito aceitável.

## Rodar

Precisa de Node 22.18 ou mais novo (roda os `.ts` direto e usa o `node:sqlite` embutido).

```bash
npm install
npm test
npm run typecheck
```

Para usar na mão, em dois terminais:

```bash
npm run fake-aggregator
```

```bash
npm start
```

| Variável | Padrão | O que é |
| --- | --- | --- |
| `PORT` | `3000` | Porta da API |
| `DATABASE_PATH` | `shipments.db` | Arquivo SQLite |
| `AGGREGATOR_BASE_URL` | `http://localhost:4000` | Endereço do agregador |
| `AGGREGATOR_TIMEOUT_MS` | `5000` | Timeout de cada chamada ao agregador |
| `DELAY_LIMIT_HOURS` | `168` | Limite global de tempo em trânsito |

## API

| Rota | O que faz |
| --- | --- |
| `POST /shipments` | Cadastra `{ code, carrier, delay_limit_hours? }` no agregador e localmente. 201 na primeira vez, 200 com o envio existente se o código já foi cadastrado. |
| `POST /shipments/:id/refresh` | Busca os eventos no agregador e junta ao histórico. |
| `GET /shipments/:id` | Lê o estado local. Não chama o agregador. |
| `GET /shipments?delayed=true` | Lista os envios; `delayed` filtra por atrasados ou não atrasados. |

Erros: 400 para entrada inválida, 404 para envio inexistente, 502 quando o agregador falha (timeout, status de erro ou payload fora do contrato). No 502 nada é gravado.

## Status

| Enunciado | Na API |
| --- | --- |
| postado | `posted` |
| em trânsito | `in_transit` |
| saiu para entrega | `out_for_delivery` |
| entregue | `delivered` |
| exceção | `exception` |

O status é `null` enquanto nenhum evento com tradução conhecida chegou.

O status atual é recalculado do histórico inteiro a cada leitura ([src/domain/status.ts](src/domain/status.ts)):

- Vale o evento com o maior `occurred_at`, que é a hora em que aconteceu na transportadora, não a hora em que chegou aqui. Por isso um evento antigo que chega depois entra no histórico e não muda o status.
- `delivered` é terminal. Um evento posterior à entrega é guardado, mas não desfaz a entrega.
- Dois eventos no mesmo instante: vence o que está mais adiante no fluxo (`posted` < `in_transit` < `out_for_delivery` < `exception` < `delivered`).
- Não usei um rank que só sobe porque ele trataria "exceção e depois em trânsito de novo" como regressão, e isso é um avanço legítimo.

Status que a transportadora inventou: o evento entra no histórico com o texto original e `status: null`, não altera o status atual e gera um log de aviso. A tradução é uma tabela explícita por transportadora ([statusMap.ts](src/adapters/aggregator/statusMap.ts)), sem valor padrão e sem casamento por pedaço de texto. "Objeto entregue ao portal interdimensional" não vira `delivered`.

## Exemplo

Payload bruto do agregador ([examples/raw-payload.json](examples/raw-payload.json)), fora de ordem, com o `cp_2` repetido e um status inventado:

```json
{
  "tracking_number": "QB123456789BR",
  "courier": "correios",
  "checkpoints": [
    { "checkpoint_id": "cp_4", "checkpoint_time": "2026-10-04T07:40:00-03:00", "status_text": "Objeto saiu para entrega ao destinatário", "city": "Florianópolis/SC" },
    { "checkpoint_id": "cp_1", "checkpoint_time": "2026-10-01T09:12:00-03:00", "status_text": "Objeto postado", "city": "São Paulo/SP" },
    { "checkpoint_id": "cp_3", "checkpoint_time": "2026-10-03T08:05:00-03:00", "status_text": "Objeto em processo de desembaraço lunar", "city": "Curitiba/PR" },
    { "checkpoint_id": "cp_2", "checkpoint_time": "2026-10-02T14:30:00-03:00", "status_text": "Objeto em transferência - por favor aguarde", "city": "Cajamar/SP" },
    { "checkpoint_id": "cp_2", "checkpoint_time": "2026-10-02T14:30:00-03:00", "status_text": "Objeto em transferência - por favor aguarde", "city": "Cajamar/SP" }
  ]
}
```

Resposta da API ([examples/normalized.json](examples/normalized.json)), consultada em 2026-10-05 com limite de 168 horas:

```json
{
  "id": "0b9f6c1e-5f0a-4c59-9d0b-3a1c2e4f7a10",
  "code": "QB123456789BR",
  "carrier": "correios",
  "status": "out_for_delivery",
  "is_delayed": false,
  "delay_limit_hours": 168,
  "in_transit_since": "2026-10-01T12:12:00.000Z",
  "events": [
    { "occurred_at": "2026-10-01T12:12:00.000Z", "status": "posted", "raw_status": "Objeto postado", "location": "São Paulo/SP" },
    { "occurred_at": "2026-10-02T17:30:00.000Z", "status": "in_transit", "raw_status": "Objeto em transferência - por favor aguarde", "location": "Cajamar/SP" },
    { "occurred_at": "2026-10-03T11:05:00.000Z", "status": null, "raw_status": "Objeto em processo de desembaraço lunar", "location": "Curitiba/PR" },
    { "occurred_at": "2026-10-04T10:40:00.000Z", "status": "out_for_delivery", "raw_status": "Objeto saiu para entrega ao destinatário", "location": "Florianópolis/SC" }
  ]
}
```

Um teste ([test/app.test.ts](test/app.test.ts)) passa o primeiro arquivo pelo cliente HTTP real e compara a resposta com o segundo, então os dois exemplos não saem de sincronia com o código.

## Atraso

Um envio está atrasado quando as duas coisas são verdade ([src/domain/delay.ts](src/domain/delay.ts)):

1. o status atual não é `delivered`;
2. `agora - início do trânsito` é maior que o limite.

O início do trânsito é o evento `posted` mais antigo. Se a transportadora nunca informou postagem, é o evento mais antigo conhecido. Sem nenhum evento não há atraso.

Entrega normal não vira atraso por causa da primeira condição: depois de entregue, o envio nunca é atrasado, mesmo consultado meses depois e mesmo que a entrega tenha acontecido depois do limite. Exatamente no limite ainda não é atraso; um milissegundo depois, é.

O limite vem do envio (`delay_limit_hours` no cadastro) ou, na falta dele, da variável global. Exceção e atraso são independentes: um pacote em `exception` continua contando tempo.

O atraso é calculado na leitura, com o relógio injetado ([`Clock`](src/domain/ports.ts)), e aparece em `is_delayed` e no filtro `?delayed=true`. Nada é gravado, então não existe alerta duplicado nem alerta desatualizado. O custo é que ninguém é avisado ativamente: quem quer saber consulta o filtro. O filtro calcula em memória sobre todos os envios, com duas queries no total; serve para o volume de um desafio, e com muitos envios o início do trânsito viraria coluna para filtrar no banco.

## Histórico sem duplicar

Cada evento tem uma chave: o id do agregador quando ele manda um; senão, horário, texto e local. A chave primária `(shipment_id, dedup_key)` no SQLite e o `INSERT OR IGNORE` fazem a consulta repetida não inserir nada ([repository.ts](src/adapters/sqlite/repository.ts)). Por estar no banco, vale também para duas consultas simultâneas.

Checkpoint com horário inválido ou sem offset é pulado com log, e os outros entram. Sem offset não dá para ordenar o evento em relação aos demais.

## Trocar de agregador

```
src/domain/     regras e portas; não conhece HTTP, SQL nem o agregador
src/adapters/   aggregator/ (cliente HTTP, payload bruto, tabela de tradução), sqlite/, relógio
src/http/       rotas Fastify
dev/            agregador fake para testes e para rodar na mão
```

O domínio depende de três portas ([src/domain/ports.ts](src/domain/ports.ts)): `TrackingProvider`, `ShipmentRepository` e `Clock`. O `TrackingProvider` devolve eventos já no formato do domínio, então o formato do agregador (`checkpoints`, `status_text`, `courier`) só existe em `src/adapters/aggregator/`. Trocar de agregador é escrever outra pasta que implemente a porta e mudar uma linha em [src/main.ts](src/main.ts).

A porta é do agregador, não da transportadora. Transportadora nova são linhas novas na tabela de tradução.

## Testes

`npm test` roda 72 testes em 6 arquivos. Os que respondem aos critérios do enunciado:

| Critério | Onde |
| --- | --- |
| Status desconhecido não vira entregue | `service.test.ts`, `aggregatorClient.test.ts`, `status.test.ts` |
| Evento fora de ordem não regride | `service.test.ts`, `status.test.ts` |
| Consultar de novo não duplica | `service.test.ts`, `sqliteRepository.test.ts` |
| Atraso com data controlada | `delay.test.ts`, `service.test.ts`, `app.test.ts` |
| Agregador trocável | `service.test.ts` usa um fake em memória da porta; `aggregatorClient.test.ts` testa o cliente real contra um servidor fake |

## Fora de escopo

- Webhook do agregador e consulta agendada: só há consulta sob demanda.
- Envio ativo de aviso (e-mail, Slack).
- Alterar o limite depois do cadastro.
- Nova tentativa automática quando o agregador falha.
- Autenticação na API e no agregador.

## Uso de IA

O código, os testes e este README foram escritos com o Claude Code.

As decisões de desenho foram minhas, respondidas uma a uma antes de qualquer código: status pelo maior `occurred_at`, entregue terminal, status desconhecido gravado sem alterar o status, deduplicação por constraint no banco, só consulta sob demanda, atraso calculado na leitura a partir da postagem, falha do agregador como 502 sem gravar nada, stack e SQLite embutido. Em duas eu fui além do que a ferramenta recomendou: pedi o limite de atraso também por envio, e propus organizar o código em portas e adaptadores.

No código, questionei os laços de `src/domain/status.ts` e `src/domain/delay.ts`: perguntei se não bastava olhar o último e o primeiro evento, já que o histórico vem ordenado. Mantive os dois como estão, para o domínio não depender da ordem que o repositório devolve. O resto do código eu ainda não revisei linha a linha.
