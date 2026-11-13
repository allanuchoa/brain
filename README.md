# Allan's Brain

Ferramenta do **Allan Workbench**: perguntas e busca sobre um acervo técnico de engenharia (normas,
regulação, livros, notas técnicas). A busca é **híbrida**: semântica (significado) e textual (termo exato)
rodam em paralelo e os resultados são fundidos. Cada resposta cita o documento e a página.

O site é estático. O servidor é o Supabase do portal: banco com vetores e texto completo, e uma função
de borda que guarda a chave do Gemini.

## O que faz

- **Perguntar:** resposta em português com citações numeradas; clicar na citação mostra o trecho e abre o PDF na página.
- **Buscar:** híbrida, só semântica, só textual, ou as três lado a lado. Aspas buscam a frase exata; `-termo` exclui.
- **Peso ajustável** entre semântica e textual, expansão da pergunta (termos em português e inglês) e reordenação por IA.
- **Acervo:** envio de PDF, imagem e texto; o texto é extraído no navegador. Páginas digitalizadas podem ser lidas por IA.
- **Avaliação:** perguntas com a resposta esperada; mede quantas vezes cada tipo de busca acerta.
- **Histórico** das perguntas, por usuário.

## Arquitetura

```
navegador ──► função de borda `brain` ──► Gemini (embeddings e resposta)
    │                │
    │                └──► Postgres: brain_search() = vetor (pgvector) + texto completo, fusão por posição
    └──► Supabase Storage (bucket privado `brain`): PDFs originais
```

| Peça | Onde |
|---|---|
| Esquema, busca híbrida, permissões | `sql/setup.sql` |
| Indexar, buscar, responder | `supabase/functions/brain/index.ts` |
| Fatiamento, realce, Markdown, métricas | `engine.js` |
| Interface | `index.html`, `app.js`, `styles.css` |
| Carga em lote pelo terminal | `tools/seed.mjs` |

Modelos: `gemini-embedding-2` em 1.536 dimensões; resposta com `gemini-3.5-flash`, com prazo de 30 s e
reserva em `gemini-2.5-flash` e `gemini-3.5-flash-lite`. Dá para trocar pelos segredos `BRAIN_GEN_MODEL`,
`BRAIN_GEN_FALLBACK`, `BRAIN_LITE_MODEL` e `BRAIN_EMBED_MODEL`. Trocar o modelo de embedding exige reindexar tudo.

## Publicar o servidor

```bash
supabase db query --linked -f sql/setup.sql
```

```bash
supabase secrets set GEMINI_API_KEY=<sua chave>
```

```bash
supabase functions deploy brain --use-api
```

A função precisa ficar com a verificação de JWT ligada (o padrão). Não publique com `--no-verify-jwt`.

## Rodar localmente

```bash
python -m http.server 8000
```

Abra `http://localhost:8000/?dev`. O `?dev` pula o bridge do portal, mas a função exige sessão: sem login, a
tela abre com aviso e sem dados.

```bash
node tests/engine.test.js
```

## Carga em lote

```bash
npm i --no-save pdfjs-dist@3.11.174
```

```bash
BRAIN_SERVICE_KEY=<service_role> node tools/seed.mjs "<pasta com PDFs>"
```

A carga é retomável: documento já indexado é pulado. A chave de serviço nunca entra no repositório.

## Limites do plano gratuito do Supabase

50 MB por arquivo, 1 GB de arquivos, 500 MB de banco. O acervo inicial (25 PDFs, 1.903 páginas) usa cerca de
180 MB de arquivos.
