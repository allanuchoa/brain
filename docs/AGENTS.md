# Diretrizes para Agentes de IA - Allan's Brain

Valem as diretrizes globais do Allan Workbench (HTML, CSS e JS puros; tema escuro; SSO pelo bridge).
Este arquivo registra só o que é específico daqui.

## Escopo

- Esta é a única ferramenta do Workbench com servidor: tabelas `brain_*`, função de borda `brain` e bucket `brain`.
- O acervo (PDFs) nunca entra no git. `node_modules/` existe só para `tools/seed.mjs` e também fica fora.
- Chaves: a do Gemini vive nos segredos do Supabase; a de serviço só em variável de ambiente local. Nenhuma no repositório.

## Arquitetura

- `engine.js` é puro (sem DOM, sem rede) e exporta `BR`. O fatiador `BR.chunkPages` é usado pelo navegador e por `tools/seed.mjs`: mudar um é mudar os dois.
- `app.js` não calcula relevância. A busca é `brain_search()` no banco; a função de borda prepara a consulta e chama o Gemini.
- Leitura passa pelo cliente do usuário (a RLS decide quem vê). Escrita no acervo usa service role dentro da função, depois de conferir `wb_is_admin()`.
- `?dev` em localhost pula o bridge. Não estenda isso a outros hosts.

## Como a busca funciona

| Etapa | Regra |
|---|---|
| Consulta textual | A função tira palavras vazias; aspas viram frase exata; `-termo` exclui. Termos soltos são OU, não E |
| Índice de texto | `fts` = português radicalizado e sem acento, mais a forma exata (`simple`) para siglas, códigos e inglês |
| Semântica | `gemini-embedding-2`, 1.536 dimensões, `RETRIEVAL_QUERY` na pergunta e `RETRIEVAL_DOCUMENT` nos trechos |
| Vetor do trecho | Leva "Documento: título" e "Seção: título" antes do texto |
| Fusão | Por posição: `peso ÷ (60 + posição)` de cada busca, somados. 40 candidatos por busca |
| Expansão | Só para perguntas; termo solto ou frase entre aspas não é reescrito, salvo se houver conversa anterior |
| Reordenação | Opcional: o modelo dá nota de 0 a 10 aos 20 melhores |

## Fatiamento

- Um trecho nunca cruza páginas: a citação da página precisa ser exata.
- Alvo de 1.200 caracteres, sobreposição de até 150 (linhas inteiras), fecha em fim de frase quando já está cheio.
- Título de seção (numerado, "Art. N", "CAPÍTULO", caixa alta) abre trecho novo e é guardado em `heading`.
- Linha curta repetida no topo ou no pé de 40% das páginas é cabeçalho ou rodapé e sai.

## Indexação e cota

- `ingest_start` recebe `chunk_sig` (sha256 dos trechos). Documento incompleto com a mesma assinatura é retomado: a função devolve `existing` (idx já gravados) e a interface envia só o resto. Assinatura diferente apaga e recomeça.
- Cota diária do Gemini esgotada em `ingest_chunks`: o trecho é gravado com `embedding` nulo e a interface manda o resto com `no_embed`. `brain_documents.pending` conta os trechos sem vetor; `embed_pending` os completa em lotes.
- Trecho sem vetor só aparece na busca textual (`brain_search` ignora vetor nulo na semântica).

## Provedores extras

- Tabela `brain_providers`, sem policy: só a função (service role) lê. A chave entra por `provider_save` e nunca volta ao navegador (só `key_hint`).
- Só APIs compatíveis com `/chat/completions` da OpenAI. Imagem (`describe`) e embeddings ficam sempre no Gemini.
- Ordem automática da resposta: provedores `first` → cadeia do Gemini → provedores `fallback`. Escolher um modelo na pergunta o põe na frente.
- OpenCode Zen: base `https://opencode.ai/inference/openai/v1`; os modelos gratuitos dão 403 fora do OpenCode.

## Cuidados

- Mudar a dimensão ou o modelo de embedding invalida todos os vetores: reindexe o acervo inteiro.
- A função confia no papel `service_role` do JWT porque o gateway confere a assinatura. Nunca publique com `--no-verify-jwt`.
- O modelo de resposta tem picos de demora; por isso há prazo e modelos de reserva em `genAnswer`.
- Nenhuma policy das tabelas do Registry (`applications`, `user_applications`) é criada ou alterada aqui.

## Ao terminar

Rode `node tests/engine.test.js`, rode a Avaliação na interface antes e depois de mexer na busca, e registre em `docs/CHANGELOG.md`.
