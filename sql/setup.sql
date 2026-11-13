-- ============================================================================
-- Allan's Brain - RAG com busca híbrida (semântica + textual) no Supabase
-- Idempotente: pode reexecutar. Rodar no SQL Editor ou pelo CLI.
--
-- O QUE CRIA
--   brain_documents / brain_chunks   acervo e trechos (vetor + índice de texto)
--   brain_search()                   busca híbrida com fusão por posição (RRF)
--   brain_queries / brain_eval       histórico e conjunto de avaliação
--   bucket privado `brain`           PDFs originais
--   registro no portal (slug `brain`)
--
-- QUEM PODE O QUÊ
--   Ler acervo, buscar e perguntar: quem tem a ferramenta `brain` liberada no portal.
--   Indexar e excluir: só admin, e só pela função de borda (service role).
--   Nenhuma policy das tabelas do Registry é criada ou alterada.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- unaccent não é IMMUTABLE; este invólucro fixa o dicionário para poder indexar
CREATE OR REPLACE FUNCTION public.brain_norm(t TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, ''));
$$;

CREATE OR REPLACE FUNCTION public.brain_can()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.wb_is_admin() OR EXISTS (
    SELECT 1 FROM public.user_applications ua JOIN public.applications a ON a.id = ua.application_id
    WHERE ua.user_id = auth.uid() AND a.slug = 'brain' AND a.is_active
      AND (ua.expires_at IS NULL OR ua.expires_at > now()));
$$;
REVOKE ALL ON FUNCTION public.brain_can() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.brain_can() TO authenticated;

-- ---------- acervo ----------
CREATE TABLE IF NOT EXISTS public.brain_documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  storage_path TEXT,                       -- caminho no bucket `brain`; NULL se o original não foi guardado
  mime         TEXT,
  category     TEXT,
  pages        INT NOT NULL DEFAULT 0,
  blank_pages  INT NOT NULL DEFAULT 0,     -- páginas sem texto extraível
  chunks       INT NOT NULL DEFAULT 0,
  chars        INT NOT NULL DEFAULT 0,
  content_hash TEXT UNIQUE,                -- sha256 do arquivo: o mesmo arquivo não entra duas vezes
  status       TEXT NOT NULL DEFAULT 'indexing' CHECK (status IN ('indexing', 'ready', 'error')),
  created_by   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.brain_chunks (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id    UUID NOT NULL REFERENCES public.brain_documents(id) ON DELETE CASCADE,
  page      INT,
  idx       INT NOT NULL,                  -- ordem do trecho no documento
  heading   TEXT,
  content   TEXT NOT NULL,
  embedding extensions.vector(1536),       -- gemini-embedding-2 reduzido a 1536 dimensões
  -- português com radicalização (inversor = inversores) + forma exata (siglas, códigos, inglês)
  fts       TSVECTOR GENERATED ALWAYS AS (
              to_tsvector('portuguese'::regconfig, public.brain_norm(coalesce(heading, '') || ' ' || content))
              || to_tsvector('simple'::regconfig, public.brain_norm(content))) STORED,
  UNIQUE (doc_id, idx)
);
CREATE INDEX IF NOT EXISTS brain_chunks_fts_idx ON public.brain_chunks USING gin (fts);
CREATE INDEX IF NOT EXISTS brain_chunks_emb_idx ON public.brain_chunks USING hnsw (embedding extensions.vector_cosine_ops);
CREATE INDEX IF NOT EXISTS brain_chunks_doc_idx ON public.brain_chunks (doc_id, idx);

CREATE TABLE IF NOT EXISTS public.brain_queries (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  question   TEXT NOT NULL,
  answer     TEXT,
  sources    JSONB NOT NULL DEFAULT '[]'::jsonb,
  params     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ms         INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brain_queries_user_idx ON public.brain_queries (user_id, created_at DESC);

-- conjunto de avaliação: pergunta e onde a resposta está
CREATE TABLE IF NOT EXISTS public.brain_eval (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question    TEXT NOT NULL,
  expect_doc  UUID REFERENCES public.brain_documents(id) ON DELETE CASCADE,
  expect_page INT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.brain_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brain_chunks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brain_queries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brain_eval      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "brain read documents" ON public.brain_documents;
CREATE POLICY "brain read documents" ON public.brain_documents FOR SELECT USING ((SELECT public.brain_can()));
DROP POLICY IF EXISTS "brain read chunks" ON public.brain_chunks;
CREATE POLICY "brain read chunks" ON public.brain_chunks FOR SELECT USING ((SELECT public.brain_can()));

DROP POLICY IF EXISTS "brain own queries read" ON public.brain_queries;
CREATE POLICY "brain own queries read" ON public.brain_queries FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS "brain own queries insert" ON public.brain_queries;
CREATE POLICY "brain own queries insert" ON public.brain_queries FOR INSERT WITH CHECK (user_id = auth.uid() AND (SELECT public.brain_can()));
DROP POLICY IF EXISTS "brain own queries delete" ON public.brain_queries;
CREATE POLICY "brain own queries delete" ON public.brain_queries FOR DELETE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "brain read eval" ON public.brain_eval;
CREATE POLICY "brain read eval" ON public.brain_eval FOR SELECT USING ((SELECT public.brain_can()));
DROP POLICY IF EXISTS "brain admin eval insert" ON public.brain_eval;
CREATE POLICY "brain admin eval insert" ON public.brain_eval FOR INSERT WITH CHECK ((SELECT public.wb_is_admin()));
DROP POLICY IF EXISTS "brain admin eval update" ON public.brain_eval;
CREATE POLICY "brain admin eval update" ON public.brain_eval FOR UPDATE USING ((SELECT public.wb_is_admin())) WITH CHECK ((SELECT public.wb_is_admin()));
DROP POLICY IF EXISTS "brain admin eval delete" ON public.brain_eval;
CREATE POLICY "brain admin eval delete" ON public.brain_eval FOR DELETE USING ((SELECT public.wb_is_admin()));

-- ============================================================================
-- BUSCA HÍBRIDA
--   p_q      consulta textual (palavras-chave; aspas = frase exata; -termo exclui)
--   p_emb    vetor da pergunta (NULL desliga a parte semântica)
--   p_mode   'hybrid' | 'semantic' | 'lexical'
--   p_w_sem  peso da semântica na fusão (0 a 1); a textual fica com 1 - p_w_sem
--   Fusão por posição (Reciprocal Rank Fusion): cada busca vota 1 / (60 + posição).
--   Roda com os direitos de quem chama: a RLS de brain_chunks vale aqui.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.brain_search(
  p_q TEXT, p_emb extensions.vector(1536) DEFAULT NULL, p_mode TEXT DEFAULT 'hybrid', p_k INT DEFAULT 8,
  p_w_sem REAL DEFAULT 0.5, p_docs UUID[] DEFAULT NULL, p_cand INT DEFAULT 40)
RETURNS TABLE (chunk_id BIGINT, doc_id UUID, title TEXT, file_name TEXT, page INT, heading TEXT, content TEXT,
               sem_rank INT, lex_rank INT, sem_sim REAL, lex_score REAL, score REAL)
LANGUAGE plpgsql STABLE SET search_path = public, extensions AS $$
DECLARE
  v_norm TEXT := public.brain_norm(coalesce(p_q, ''));
  v_tsq  TSQUERY;
  v_w    REAL := least(greatest(coalesce(p_w_sem, 0.5), 0), 1);
BEGIN
  -- termos soltos viram OU (uma pergunta inteira não pode exigir todas as palavras);
  -- frases entre aspas (<->) e exclusões (!) são preservadas
  v_tsq := regexp_replace(websearch_to_tsquery('portuguese', v_norm)::text, ' & (?!!)', ' | ', 'g')::tsquery
        || regexp_replace(websearch_to_tsquery('simple', v_norm)::text, ' & (?!!)', ' | ', 'g')::tsquery;

  RETURN QUERY
  WITH sem AS (
    SELECT x.id, (row_number() OVER (ORDER BY x.dist))::int AS rk, (1 - x.dist)::real AS sim
    FROM (SELECT c.id, c.embedding <=> p_emb AS dist FROM brain_chunks c
          WHERE p_mode IN ('hybrid', 'semantic') AND p_emb IS NOT NULL AND c.embedding IS NOT NULL
            AND (p_docs IS NULL OR c.doc_id = ANY (p_docs))
          ORDER BY c.embedding <=> p_emb LIMIT p_cand) x),
  lex AS (
    SELECT x.id, (row_number() OVER (ORDER BY x.sc DESC, x.id))::int AS rk, x.sc
    FROM (SELECT c.id, ts_rank_cd(c.fts, v_tsq, 32)::real AS sc FROM brain_chunks c
          WHERE p_mode IN ('hybrid', 'lexical') AND numnode(v_tsq) > 0 AND c.fts @@ v_tsq
            AND (p_docs IS NULL OR c.doc_id = ANY (p_docs))
          ORDER BY 2 DESC, c.id LIMIT p_cand) x),
  fused AS (
    SELECT coalesce(s.id, l.id) AS id, s.rk AS srk, l.rk AS lrk, s.sim, l.sc,
           (coalesce(v_w / (60 + s.rk), 0) + coalesce((1 - v_w) / (60 + l.rk), 0))::real AS fs
    FROM sem s FULL JOIN lex l ON l.id = s.id)
  SELECT c.id, d.id, d.title, d.file_name, c.page, c.heading, c.content, f.srk, f.lrk, f.sim, f.sc, f.fs
  FROM fused f JOIN brain_chunks c ON c.id = f.id JOIN brain_documents d ON d.id = c.doc_id
  ORDER BY f.fs DESC, c.id LIMIT least(greatest(coalesce(p_k, 8), 1), 50);
END;
$$;
REVOKE ALL ON FUNCTION public.brain_search(TEXT, extensions.vector, TEXT, INT, REAL, UUID[], INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.brain_search(TEXT, extensions.vector, TEXT, INT, REAL, UUID[], INT) TO authenticated, service_role;

-- ---------- arquivos originais: bucket privado, 50 MB por arquivo (limite do plano gratuito) ----------
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('brain', 'brain', false, 52428800)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS "brain files read" ON storage.objects;
CREATE POLICY "brain files read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'brain' AND (SELECT public.brain_can()));
DROP POLICY IF EXISTS "brain files insert" ON storage.objects;
CREATE POLICY "brain files insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'brain' AND (SELECT public.wb_is_admin()));
DROP POLICY IF EXISTS "brain files delete" ON storage.objects;
CREATE POLICY "brain files delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'brain' AND (SELECT public.wb_is_admin()));

-- ---------- registro no portal ----------
INSERT INTO public.applications (slug, name, url, icon, category, description, keywords, status, is_active)
VALUES ('brain', 'Allan''s Brain', 'https://allanuchoa.github.io/brain/', 'brain', 'Engenharia',
        'Pergunte ao acervo técnico: busca semântica e textual com citação da página',
        'rag busca norma documento pdf pergunta resposta ia acervo conhecimento', 'active', true)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name, url = EXCLUDED.url, icon = EXCLUDED.icon, category = EXCLUDED.category,
  description = EXCLUDED.description, keywords = EXCLUDED.keywords, is_active = true;

INSERT INTO public.user_applications (user_id, application_id)
SELECT p.id, a.id FROM public.profiles p CROSS JOIN public.applications a
WHERE p.role = 'admin' AND a.slug = 'brain'
ON CONFLICT (user_id, application_id) DO NOTHING;

COMMIT;
