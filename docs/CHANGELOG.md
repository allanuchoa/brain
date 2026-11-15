# Changelog - Allan's Brain

## [2.1.0] - 2026-11-15
### Adicionado
- Aba Modelos (só admin): provedores extras compatíveis com a API da OpenAI (NVIDIA, OpenCode Zen ou outro), com chave, modelo, uso (antes do Gemini, reserva ou só quando escolhido) e ordem. Botões para testar e listar modelos. A chave fica em `brain_providers`, lida só pela função; a tela mostra os 4 últimos caracteres. (Autor: Agente de IA Claude Opus 5.5)
- Escolha do modelo da resposta em Perguntar; se ele falhar, os outros entram em sequência, com prazo total de 110 s. (Autor: Agente de IA Claude Opus 5.5)
- Expansão e reordenação usam o primeiro provedor extra quando o Gemini falha. (Autor: Agente de IA Claude Opus 5.5)

### Alterado
- Layout responsivo: abas e botões cabem no celular, tabelas viram cartões abaixo de 640 px, campos com 16 px (sem zoom no iOS), alvos de toque de 40 px e altura do chat por `dvh`. (Autor: Agente de IA Claude Opus 5.5)

## [2.0.1] - 2026-11-15
### Corrigido
- Indexação falhava com "unsupported Unicode escape sequence" em PDFs com caractere nulo; o fatiador agora o remove. (Autor: Agente de IA Claude Opus 5.5)
- Reenvio de um arquivo já guardado no bucket falhava por RLS (sobrescrever exige policy de UPDATE); o envio não sobrescreve mais e aceita o arquivo existente, que tem o mesmo hash. (Autor: Agente de IA Claude Opus 5.5)

## [2.0.0] - 2026-11-13
Reescrita completa da RAG, agora dentro do portal. A versão 1 (FastAPI, Pinecone, um vetor por documento) fica arquivada no repositório privado antigo.

### Adicionado
- Busca híbrida em SQL (`brain_search`): semântica por pgvector e textual por texto completo, fundidas por posição com peso ajustável. (Autor: Agente de IA Claude Fable 5.2)
- Indexação por trecho com página e título de seção; fatiador compartilhado entre navegador e carga em lote. (Autor: Agente de IA Claude Fable 5.2)
- Função de borda `brain`: indexar, buscar, responder com citações, expandir a pergunta, reordenar e transcrever imagem. (Autor: Agente de IA Claude Fable 5.2)
- Interface com Perguntar, Buscar (três modos lado a lado), Acervo e Avaliação; histórico por usuário. (Autor: Agente de IA Claude Fable 5.2)
- Conjunto de avaliação com acerto em 1º, entre 3, entre 5 e MRR por tipo de busca. (Autor: Agente de IA Claude Fable 5.2)
- PDFs originais em bucket privado, abertos na página citada. (Autor: Agente de IA Claude Fable 5.2)
- Prazo e modelos de reserva na geração da resposta. (Autor: Agente de IA Claude Fable 5.2)

### Alterado
- Vetores de 3.072 para 1.536 dimensões (limite do índice do Postgres). (Autor: Agente de IA Claude Fable 5.2)
- Assistente deixa de ter tema fixo em BESS e PVsyst; passa a cobrir engenharia em geral. (Autor: Agente de IA Claude Fable 5.2)

### Removido
- Pinecone, FastAPI e o envio do PDF inteiro ao modelo a cada pergunta. (Autor: Agente de IA Claude Fable 5.2)
