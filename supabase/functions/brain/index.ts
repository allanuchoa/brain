// Função de borda do Allan's Brain. Guarda a chave do Gemini (segredo GEMINI_API_KEY) e faz:
//   search          busca híbrida, semântica ou textual (com expansão e reordenação opcionais)
//   ask             busca + resposta com citações
//   ingest_*        indexação de trechos (só admin)
//   describe        transcreve imagem ou página digitalizada (só admin)
//   delete_doc      remove documento, trechos e arquivo (só admin)
// Leitura passa pelo cliente do usuário (a RLS decide); escrita no acervo usa service role depois de conferir admin.
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const GEMINI = Deno.env.get("GEMINI_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!, SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMB = Deno.env.get("BRAIN_EMBED_MODEL") ?? "gemini-embedding-2";
const GEN = Deno.env.get("BRAIN_GEN_MODEL") ?? "gemini-3.5-flash";
const LITE = Deno.env.get("BRAIN_LITE_MODEL") ?? "gemini-3.5-flash-lite";
const DIM = 1536, BUCKET = "brain";
const ORIGINS = ["https://allanuchoa.github.io", "http://127.0.0.1", "http://localhost"];

class Fail extends Error { constructor(public status: number, msg: string) { super(msg); } }

function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.some((a) => o === a || o.startsWith(a + ":")) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// ---------- Gemini ----------
async function gem(path: string, body: unknown, tries = 2, timeoutMs = 60000): Promise<any> {
  if (!GEMINI) throw new Fail(500, "Chave do Gemini não configurada na função.");
  let r: Response;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${path}`, {
      method: "POST", headers: { "x-goog-api-key": GEMINI, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (_e) { throw new Fail(504, "O Gemini demorou demais para responder."); }
  if ((r.status === 429 || r.status >= 500) && tries > 1) { await new Promise((s) => setTimeout(s, 2500)); return gem(path, body, tries - 1, timeoutMs); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 429) throw new Fail(429, "Limite por minuto da chave do Gemini atingido. Aguarde um minuto e tente de novo.");
  if (!r.ok) throw new Fail(502, `Gemini respondeu ${r.status}: ${String(j?.error?.message ?? "").slice(0, 200)}`);
  return j;
}
async function embed(texts: string[], taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const j = await gem(`${EMB}:batchEmbedContents`, {
      requests: texts.slice(i, i + 100).map((t) => ({ model: `models/${EMB}`, content: { parts: [{ text: t }] }, taskType, outputDimensionality: DIM })),
    });
    out.push(...j.embeddings.map((e: any) => e.values));
  }
  return out;
}
const textOf = (j: any) => (j?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
async function genJson(prompt: string): Promise<any> {
  const j = await gem(`${LITE}:generateContent`, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0 } }, 1, 12000);
  return JSON.parse(textOf(j));
}
// Resposta: o modelo principal tem picos de demora de mais de um minuto. Cada tentativa tem prazo; estourou ou falhou, passa ao próximo.
const GEN_CHAIN = [...new Set([GEN, ...(Deno.env.get("BRAIN_GEN_FALLBACK") ?? "gemini-2.5-flash,gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean)])];
async function genAnswer(body: Record<string, unknown>): Promise<{ text: string; model: string }> {
  let last: unknown;
  for (const [i, model] of GEN_CHAIN.entries()) {
    try {
      const text = textOf(await gem(`${model}:generateContent`, body, 1, i === 0 ? 30000 : 25000)).trim();
      if (text) return { text, model };
    } catch (e) { last = e; console.warn(`modelo ${model} falhou:`, e instanceof Error ? e.message : e); }
  }
  throw last instanceof Fail ? last : new Fail(502, "Nenhum modelo do Gemini respondeu a tempo. Tente de novo em instantes.");
}

// ---------- consulta textual ----------
const STOP = new Set(("a o as os um uma uns umas de do da dos das em no na nos nas por para pra com sem que qual quais como quando onde e ou se é são ser foi era tem têm ter há ao à às aos me te " +
  "sobre entre mais menos muito pelo pela pelos pelas isso isto este esta esse essa aquele aquela seu sua meu minha quanto quantos pode podem deve devem existe existem " +
  "the of and or in on at for to is are was be what which how does do an by with from about that this it as").split(" "));
// mantém "frases exatas" e -exclusões; tira palavras vazias do resto (número de norma como 14.300 fica inteiro)
function lexQuery(q: string): string {
  const keep: string[] = [];
  const rest = q.replace(/"[^"]+"/g, (m) => { keep.push(m); return " "; });
  const words = rest.split(/\s+/).map((w) => w.replace(/[?!,;:()\[\]"]/g, "").replace(/\.+$/, ""))
    .filter((w) => w && (w.startsWith("-") ? w.length > 1 : !STOP.has(w.toLowerCase())));
  return [...keep, ...words].join(" ").trim();
}

type Row = { chunk_id: number; doc_id: string; title: string; file_name: string; page: number | null; heading: string | null; content: string;
  sem_rank: number | null; lex_rank: number | null; sem_sim: number | null; lex_score: number | null; score: number; rerank?: number };

async function retrieve(b: any, db: SupabaseClient) {
  const q = String(b.q ?? "").trim().slice(0, 2000);
  if (!q) throw new Fail(400, "Pergunta vazia.");
  const mode = ["semantic", "lexical", "hybrid"].includes(b.mode) ? b.mode : "hybrid";
  const k = Math.min(Math.max(Number(b.k) || 8, 1), 30), w = Math.min(Math.max(b.w_sem == null ? 0.5 : Number(b.w_sem), 0), 1);
  const docs = Array.isArray(b.docs) && b.docs.length ? b.docs.slice(0, 200) : null;

  // expansão: reescreve a pergunta de forma autônoma (usa o histórico) e sugere termos em PT e EN para a busca textual
  let standalone = q, extra: string[] = [];
  // termo solto ou frase entre aspas é busca por palavra-chave: reescrever só atrapalha (a menos que dependa da conversa)
  const keyword = (q.split(/\s+/).length <= 3 || q.includes('"')) && !(Array.isArray(b.history) && b.history.length);
  if (b.expand && !keyword) {
    try {
      const hist = (Array.isArray(b.history) ? b.history.slice(-3) : []).map((h: any) => `Usuário: ${String(h.q).slice(0, 300)}\nAssistente: ${String(h.a).slice(0, 400)}`).join("\n");
      const j = await genJson(
        `Você prepara consultas para um acervo técnico de engenharia (português e inglês).\n${hist ? "Conversa até aqui:\n" + hist + "\n" : ""}` +
        `Pergunta atual: ${q}\n\nDevolva JSON com:\n- "pergunta": a pergunta atual reescrita de forma autônoma e completa, em português, sem mudar o sentido;\n` +
        `- "termos_pt": até 5 termos técnicos, siglas ou sinônimos úteis para busca por palavra exata;\n- "termos_en": os equivalentes em inglês (até 5).\nNão invente números de norma que não estejam na pergunta.`);
      if (typeof j?.pergunta === "string" && j.pergunta.trim()) standalone = j.pergunta.trim().slice(0, 2000);
      extra = [...(j?.termos_pt ?? []), ...(j?.termos_en ?? [])].filter((t: unknown) => typeof t === "string").slice(0, 10);
    } catch (_e) { /* sem expansão: segue com a pergunta original */ }
  }
  const lex = [lexQuery(q), lexQuery(extra.join(" ").replace(/["-]/g, " "))].filter(Boolean).join(" ");
  const needEmb = b.compare || mode !== "lexical";
  const emb = needEmb ? JSON.stringify((await embed([standalone], "RETRIEVAL_QUERY"))[0]) : null;

  const run = async (m: string, n: number): Promise<Row[]> => {
    const { data, error } = await db.rpc("brain_search", { p_q: lex, p_emb: m === "lexical" ? null : emb, p_mode: m, p_k: n, p_w_sem: w, p_docs: docs, p_cand: 40 });
    if (error) throw new Fail(500, "Falha na busca: " + error.message);
    return (data ?? []) as Row[];
  };

  if (b.compare) {
    const [semantic, lexical, hybrid] = await Promise.all([run("semantic", k), run("lexical", k), run("hybrid", k)]);
    return { standalone, lex, extra, lists: { semantic, lexical, hybrid }, results: hybrid };
  }
  let results = await run(mode, b.rerank ? Math.max(k, 20) : k);

  // reordenação: o modelo dá nota de 0 a 10 à utilidade de cada trecho para a pergunta
  if (b.rerank && results.length > 2) {
    try {
      const j = await genJson(
        `Pergunta: ${standalone}\n\nDê uma nota de 0 a 10 para o quanto cada trecho ajuda a responder a pergunta (10 = responde diretamente).\n` +
        results.map((r, i) => `[${i}] (${r.title}${r.page ? ", p. " + r.page : ""}) ${r.content.slice(0, 600)}`).join("\n\n") +
        `\n\nDevolva JSON: {"notas": [{"i": índice, "nota": número}]} com todos os trechos.`);
      const nota = new Map<number, number>((j?.notas ?? []).map((x: any) => [Number(x.i), Number(x.nota)]));
      results = results.map((r, i) => ({ ...r, rerank: nota.get(i) ?? 0 })).sort((a, c) => (c.rerank! - a.rerank!) || (c.score - a.score));
    } catch (_e) { /* sem reordenação: mantém a ordem da fusão */ }
    results = results.slice(0, k);
  }
  return { standalone, lex, extra, results };
}

const SYSTEM = "Você é o Brain, assistente técnico de engenharia do Allan. O acervo cobre energia, sistemas elétricos, armazenamento (BESS), " +
  "geração solar, normas e regulação, e engenharia em geral. Responda em português, de forma direta e tecnicamente precisa, usando SOMENTE os trechos numerados fornecidos. " +
  "Depois de cada afirmação, cite a fonte com o número do trecho entre colchetes, como [2] ou [1][4]. Preserve números, unidades, siglas e nomes de normas exatamente como estão nos trechos. " +
  "Se os trechos não bastam para responder, diga claramente o que não foi encontrado e responda só a parte coberta; nunca complete com conhecimento de fora. " +
  "Use Markdown simples: parágrafos curtos, listas e negrito quando ajudar. Não repita a pergunta nem liste as fontes ao final.";

async function ask(b: any, db: SupabaseClient, save: boolean) {
  const t0 = Date.now();
  const r = await retrieve({ ...b, expand: b.expand !== false, compare: false }, db);
  let answer: string, model = "";
  if (!r.results.length) answer = "Não encontrei no acervo nenhum trecho relacionado a essa pergunta.";
  else {
    const ctx = r.results.map((x, i) => `[${i + 1}] ${x.title}${x.page ? " — página " + x.page : ""}${x.heading ? " — " + x.heading : ""}\n${x.content}`).join("\n\n");
    const hist = (Array.isArray(b.history) ? b.history.slice(-3) : []).map((h: any) => `Usuário: ${String(h.q).slice(0, 300)}\nAssistente: ${String(h.a).slice(0, 600)}`).join("\n");
    const g = await genAnswer({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ parts: [{ text: `Trechos do acervo:\n\n${ctx}\n\n${hist ? "Conversa até aqui:\n" + hist + "\n\n" : ""}Pergunta: ${String(b.q).trim()}` }] }],
      generationConfig: { temperature: 0.2 },
    });
    answer = g.text; model = g.model;
  }
  const ms = Date.now() - t0;
  if (save) {
    await db.from("brain_queries").insert({
      question: String(b.q).trim().slice(0, 2000), answer, ms,
      sources: r.results.map((x, i) => ({ n: i + 1, chunk_id: x.chunk_id, doc_id: x.doc_id, title: x.title, page: x.page })),
      params: { mode: b.mode ?? "hybrid", k: b.k ?? 8, w_sem: b.w_sem ?? 0.5, rerank: !!b.rerank },
    });
  }
  return { answer, sources: r.results, standalone: r.standalone, lex: r.lex, ms, model };
}

// ---------- indexação (admin) ----------
async function ingestStart(b: any, svc: SupabaseClient, uid: string | null) {
  const hash = String(b.content_hash ?? "");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Fail(400, "Hash do arquivo ausente.");
  const { data: old } = await svc.from("brain_documents").select("id, status").eq("content_hash", hash).maybeSingle();
  if (old?.status === "ready" && !b.replace) return { duplicate: true, id: old.id };
  if (old) await svc.from("brain_documents").delete().eq("id", old.id);   // indexação anterior incompleta, ou troca pedida
  const { data, error } = await svc.from("brain_documents").insert({
    title: String(b.title || b.file_name).slice(0, 200), file_name: String(b.file_name).slice(0, 300), storage_path: b.storage_path ?? null,
    mime: b.mime ?? null, category: b.category ? String(b.category).slice(0, 60) : null, pages: Number(b.pages) || 0,
    blank_pages: Number(b.blank_pages) || 0, chars: Number(b.chars) || 0, content_hash: hash, created_by: uid,
  }).select("id").single();
  if (error) throw new Fail(500, "Não consegui registrar o documento: " + error.message);
  return { id: data.id };
}
async function ingestChunks(b: any, svc: SupabaseClient) {
  const chunks = (Array.isArray(b.chunks) ? b.chunks : []).filter((c: any) => c && typeof c.content === "string" && c.content.trim());
  if (!b.doc_id || !chunks.length || chunks.length > 64) throw new Fail(400, "Envie de 1 a 64 trechos por chamada.");
  const { data: doc } = await svc.from("brain_documents").select("title").eq("id", b.doc_id).maybeSingle();
  if (!doc) throw new Fail(404, "Documento não encontrado.");
  // o vetor leva o título e a seção junto: um trecho solto perde o contexto de onde veio
  const vecs = await embed(chunks.map((c: any) => `Documento: ${doc.title}\n${c.heading ? "Seção: " + c.heading + "\n" : ""}${c.content}`.slice(0, 8000)), "RETRIEVAL_DOCUMENT");
  const rows = chunks.map((c: any, i: number) => ({
    doc_id: b.doc_id, page: Number.isFinite(c.page) ? c.page : null, idx: Number(c.idx), heading: c.heading ? String(c.heading).slice(0, 200) : null,
    content: String(c.content).slice(0, 6000), embedding: JSON.stringify(vecs[i]),
  }));
  const { error } = await svc.from("brain_chunks").upsert(rows, { onConflict: "doc_id,idx" });
  if (error) throw new Fail(500, "Não consegui gravar os trechos: " + error.message);
  return { saved: rows.length };
}
async function ingestFinish(b: any, svc: SupabaseClient) {
  const { count } = await svc.from("brain_chunks").select("id", { count: "exact", head: true }).eq("doc_id", b.doc_id);
  const { error } = await svc.from("brain_documents").update({ status: count ? "ready" : "error", chunks: count ?? 0 }).eq("id", b.doc_id);
  if (error) throw new Fail(500, error.message);
  return { chunks: count ?? 0 };
}
async function deleteDoc(b: any, svc: SupabaseClient) {
  const { data: doc } = await svc.from("brain_documents").select("storage_path").eq("id", b.doc_id).maybeSingle();
  if (!doc) throw new Fail(404, "Documento não encontrado.");
  if (doc.storage_path) await svc.storage.from(BUCKET).remove([doc.storage_path]);
  const { error } = await svc.from("brain_documents").delete().eq("id", b.doc_id);
  if (error) throw new Fail(500, error.message);
  return { ok: true };
}
async function describe(b: any) {
  if (typeof b.data !== "string" || b.data.length > 8_000_000 || !/^image\/(png|jpeg|webp)$/.test(b.mime ?? "")) throw new Fail(400, "Imagem inválida ou grande demais.");
  const g = await genAnswer({
    contents: [{ parts: [{ inlineData: { mimeType: b.mime, data: b.data } },
      { text: "Transcreva fielmente todo o texto desta imagem, na ordem de leitura. Para tabelas, preserve linhas e colunas. Para figuras, diagramas e gráficos, descreva o que mostram, com valores, unidades e legendas. Não comente nem resuma: devolva só o conteúdo." }] }],
    generationConfig: { temperature: 0 },
  });
  return { text: g.text };
}

Deno.serve(async (req) => {
  const H = { ...cors(req), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  try {
    if (req.method !== "POST") throw new Fail(405, "Use POST.");
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const svc = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
    let db = svc, admin = false, uid: string | null = null;
    // Uso interno (carga inicial do acervo): token de service role. A assinatura do JWT já foi conferida
    // pelo gateway do Supabase (verify_jwt ligado, o padrão); NÃO publique esta função com --no-verify-jwt.
    let role = "";
    try { role = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role ?? ""; } catch (_e) { role = ""; }
    if (role === "service_role") admin = true;
    else {
      db = createClient(SB_URL, ANON, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
      const { data: u } = await db.auth.getUser(token);
      if (!u?.user) throw new Fail(401, "Sessão inválida. Entre de novo pelo portal.");
      uid = u.user.id;
      const [{ data: can }, { data: adm }] = await Promise.all([db.rpc("brain_can"), db.rpc("wb_is_admin")]);
      if (!can) throw new Fail(403, "Você não tem acesso a esta ferramenta.");
      admin = !!adm;
    }
    const b = await req.json().catch(() => ({}));
    const needAdmin = () => { if (!admin) throw new Fail(403, "Só o administrador pode alterar o acervo."); };
    let out: unknown;
    switch (b.action) {
      case "search": out = await retrieve(b, db); break;
      case "ask": out = await ask(b, db, !!uid); break;
      case "ingest_start": needAdmin(); out = await ingestStart(b, svc, uid); break;
      case "ingest_chunks": needAdmin(); out = await ingestChunks(b, svc); break;
      case "ingest_finish": needAdmin(); out = await ingestFinish(b, svc); break;
      case "delete_doc": needAdmin(); out = await deleteDoc(b, svc); break;
      case "describe": needAdmin(); out = await describe(b); break;
      case "whoami": out = { admin, models: { embed: EMB, gen: GEN, lite: LITE, dim: DIM } }; break;
      default: throw new Fail(400, "Ação desconhecida.");
    }
    return new Response(JSON.stringify(out), { headers: H });
  } catch (e) {
    const status = e instanceof Fail ? e.status : 500;
    if (status >= 500) console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Erro inesperado." }), { status, headers: H });
  }
});
