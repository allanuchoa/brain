# PRD - Allan's Brain

## Necessidade

Consultar um acervo técnico de engenharia (normas, regulação, notas técnicas, livros) por pergunta em
linguagem natural ou por termo exato, e receber a resposta com a página de origem. A versão anterior
só fazia busca semântica, com um vetor por documento inteiro: não localizava a página e falhava em
siglas e números de norma.

## Público e uso

Uso próprio, pelo portal. Convidados com acesso temporário podem perguntar e buscar; só o administrador altera o acervo.

## Requisitos

| Requisito | Atendimento |
|---|---|
| Achar por significado | Busca semântica por trecho (pgvector, Gemini Embedding 2) |
| Achar por termo exato | Busca textual em português e forma exata; aspas e exclusão |
| Combinar as duas | Fusão por posição com peso ajustável; modo que mostra as três lado a lado |
| Saber de onde veio | Citação numerada com documento e página; abre o PDF na página |
| Não inventar | Resposta restrita aos trechos; diz quando não encontrou |
| Engenharia em geral | Instrução do assistente sem tema fixo; categorias livres no acervo |
| Acervo em inglês e português | Expansão da pergunta com termos nas duas línguas |
| Medir a qualidade | Conjunto de avaliação e métricas por tipo de busca |
| Manter o acervo | Envio pelo navegador, reindexação, exclusão, contagem de páginas sem texto |
| Sem chave exposta | Chave do Gemini só na função de borda |

## Fora do escopo

- Resposta em fluxo (palavra por palavra).
- Busca por imagem como pergunta.
- Vídeo e áudio no acervo.
- Edição de categoria e título depois do envio.

## Indicadores de qualidade

Acerto em 1º, entre os 3 e entre os 5 primeiros, e MRR, por tipo de busca, sobre o conjunto de avaliação.
