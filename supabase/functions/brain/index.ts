// Função de borda do Allan's Brain. Guarda a chave do Gemini (segredo GEMINI_API_KEY) e faz:
//   search          busca híbrida, semântica ou textual (com expansão e reordenação opcionais)
//   ask             busca + resposta com citações
//   ingest_*        indexação de trechos (só admin)
//   describe        transcreve imagem ou página digitalizada (só admin)
//   delete_doc      remove documento, trechos e arquivo (só admin)
//   provider_*      chaves e modelos de provedores extras compatíveis com a OpenAI (só admin)
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
  if (r.status === 429) {
    const daily = JSON.stringify(j?.error?.details ?? "").includes("PerDay");
    throw new Fail(429, daily ? "Cota diária da chave do Gemini esgotada. Ela reabre no dia seguinte; o plano pago remove esse limite."
      : "Limite por minuto da chave do Gemini atingido. Aguarde um minuto e tente de novo.");
  }
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

// ---------- provedores extras: qualquer API compatível com /chat/completions da OpenAI (NVIDIA, OpenCode Zen, OpenRouter...) ----------
type Prov = { id: string; name: string; base_url: string; api_key: string; model: string; slot: "first" | "fallback" | "off"; position: number };
const SLOTS = ["first", "fallback", "off"];
// sem a tabela (SQL ainda não rodado) a função segue só com o Gemini
async function loadProviders(svc: SupabaseClient): Promise<Prov[]> {
  const { data, error } = await svc.from("brain_providers").select("*").order("position").order("id");
  return error ? [] : (data ?? []) as Prov[];
}
const errText = (j: any) => String(j?.error?.message ?? (typeof j?.error === "string" ? j.error : "") ?? "") || String(j?.detail ?? j?.message ?? "");
async function chat(p: Prov, system: string, user: string, temperature: number, timeoutMs: number): Promise<string> {
  if (!p.api_key) throw new Fail(400, `${p.name}: chave não configurada.`);
  let r: Response;
  try {
    r = await fetch(p.base_url.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${p.api_key}`, "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model: p.model, temperature, max_tokens: 4096, messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }] }),
    });
  } catch (_e) { throw new Fail(504, `${p.name} demorou demais para responder.`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Fail(r.status === 429 ? 429 : 502, `${p.name} respondeu ${r.status}: ${errText(j).slice(0, 200)}`);
  const c = j?.choices?.[0]?.message?.content;
  // modelos de raciocínio às vezes devolvem o pensamento entre <think>: não é resposta
  return (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? "").join("") : "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
// o OpenCode Zen lista os modelos fora do caminho /openai/v1
const modelsUrl = (base: string) => base.replace(/\/+$/, "").replace(/^(https:\/\/opencode\.ai\/inference)\/openai\/v1$/, "$1/v1") + "/models";
const parseJson = (t: string) => JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));

async function genJson(prompt: string, provs: Prov[] = []): Promise<any> {
  try {
    const j = await gem(`${LITE}:generateContent`, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0 } }, 1, 12000);
    return JSON.parse(textOf(j));
  } catch (e) {
    const p = provs.find((x) => x.api_key && x.slot !== "off");   // um só: expansão e reordenação são opcionais, não podem atrasar muito
    if (!p) throw e;
    return parseJson(await chat(p, "Responda somente com um objeto JSON válido, sem texto em volta.", prompt, 0, 15000));
  }
}
// Resposta: o modelo principal tem picos de demora de mais de um minuto. Cada tentativa tem prazo; estourou ou falhou, passa ao próximo.
const GEN_CHAIN = [...new Set([GEN, ...(Deno.env.get("BRAIN_GEN_FALLBACK") ?? "gemini-2.5-flash,gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean)])];
type Gen = { system?: string; user: string; image?: { mime: string; data: string }; temperature: number };
type Step = { label: string; ms: number; run: (ms: number) => Promise<string> };
// pick: "" = ordem automática (provedores "first", Gemini, provedores "fallback"); "gemini" ou o id de um provedor = esse primeiro
function answerSteps(g: Gen, provs: Prov[], pick: string): Step[] {
  const body = {
    ...(g.system ? { systemInstruction: { parts: [{ text: g.system }] } } : {}),
    contents: [{ parts: [...(g.image ? [{ inlineData: { mimeType: g.image.mime, data: g.image.data } }] : []), { text: g.user }] }],
    generationConfig: { temperature: g.temperature },
  };
  const gemini: Step[] = GEN_CHAIN.map((m, i) => ({ label: m, ms: i === 0 ? 30000 : 25000, run: async (ms) => textOf(await gem(`${m}:generateContent`, body, 1, ms)).trim() }));
  const ext = (p: Prov): Step => ({ label: `${p.name} · ${p.model}`, ms: 45000, run: (ms) => chat(p, g.system ?? "", g.user, g.temperature, ms) });
  const usable = g.image ? [] : provs.filter((p) => p.api_key);   // imagem só o Gemini lê
  const chosen = usable.find((p) => p.id === pick), on = usable.filter((p) => p.slot !== "off" && p !== chosen);
  if (chosen) return [ext(chosen), ...gemini, ...on.map(ext)];
  if (pick === "gemini") return [...gemini, ...on.map(ext)];
  return [...on.filter((p) => p.slot === "first").map(ext), ...gemini, ...on.filter((p) => p.slot === "fallback").map(ext)];
}
async function genAnswer(g: Gen, provs: Prov[] = [], pick = ""): Promise<{ text: string; model: string }> {
  const end = Date.now() + 110000;   // a função tem uns 150 s de relógio: guarda folga para buscar e gravar
  let last: unknown;
  for (const s of answerSteps(g, provs, pick)) {
    const left = end - Date.now(); if (left < 8000) break;
    try {
      const text = await s.run(Math.min(s.ms, left));
      if (text) return { text, model: s.label };
    } catch (e) { last = e; console.warn(`modelo ${s.label} falhou:`, e instanceof Error ? e.message : e); }
  }
  throw last instanceof Fail ? last : new Fail(502, "Nenhum modelo respondeu a tempo. Tente de novo em instantes.");
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

async function retrieve(b: any, db: SupabaseClient, provs: Prov[] = []) {
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
        `- "termos_pt": até 5 termos técnicos, siglas ou sinônimos úteis para busca por palavra exata;\n- "termos_en": os equivalentes em inglês (até 5).\nNão invente números de norma que não estejam na pergunta.`, provs);
      if (typeof j?.pergunta === "string" && j.pergunta.trim()) standalone = j.pergunta.trim().slice(0, 2000);
      extra = [...(j?.termos_pt ?? []), ...(j?.termos_en ?? [])].filter((t: unknown) => typeof t === "string").slice(0, 10);
    } catch (_e) { /* sem expansão: segue com a pergunta original */ }
  }
  const lex = [lexQuery(q), lexQuery(extra.join(" ").replace(/["-]/g, " "))].filter(Boolean).join(" ");
  const needEmb = b.compare || mode !== "lexical";
  // sem cota de embeddings a busca não para: segue só com a parte textual e avisa
  let emb: string | null = null, notice = "";
  if (needEmb) {
    try { emb = JSON.stringify((await embed([standalone], "RETRIEVAL_QUERY"))[0]); }
    catch (e) { if (!(e instanceof Fail) || e.status !== 429 || mode === "semantic" && !b.compare) throw e; notice = "Busca semântica indisponível agora (" + e.message + ") Usando só a busca textual."; }
  }

  const run = async (m: string, n: number): Promise<Row[]> => {
    if (!emb && m !== "lexical") { if (m === "semantic") return []; m = "lexical"; }
    const { data, error } = await db.rpc("brain_search", { p_q: lex, p_emb: m === "lexical" ? null : emb, p_mode: m, p_k: n, p_w_sem: w, p_docs: docs, p_cand: 40 });
    if (error) throw new Fail(500, "Falha na busca: " + error.message);
    return (data ?? []) as Row[];
  };

  if (b.compare) {
    const [semantic, lexical, hybrid] = await Promise.all([run("semantic", k), run("lexical", k), run("hybrid", k)]);
    return { standalone, lex, extra, notice, lists: { semantic, lexical, hybrid }, results: hybrid };
  }
  let results = await run(mode, b.rerank ? Math.max(k, 20) : k);

  // reordenação: o modelo dá nota de 0 a 10 à utilidade de cada trecho para a pergunta
  if (b.rerank && results.length > 2) {
    try {
      const j = await genJson(
        `Pergunta: ${standalone}\n\nDê uma nota de 0 a 10 para o quanto cada trecho ajuda a responder a pergunta (10 = responde diretamente).\n` +
        results.map((r, i) => `[${i}] (${r.title}${r.page ? ", p. " + r.page : ""}) ${r.content.slice(0, 600)}`).join("\n\n") +
        `\n\nDevolva JSON: {"notas": [{"i": índice, "nota": número}]} com todos os trechos.`, provs);
      const nota = new Map<number, number>((j?.notas ?? []).map((x: any) => [Number(x.i), Number(x.nota)]));
      results = results.map((r, i) => ({ ...r, rerank: nota.get(i) ?? 0 })).sort((a, c) => (c.rerank! - a.rerank!) || (c.score - a.score));
    } catch (_e) { /* sem reordenação: mantém a ordem da fusão */ }
    results = results.slice(0, k);
  }
  return { standalone, lex, extra, notice, results };
}

const SYSTEM = "Você é o Brain, assistente técnico de engenharia do Allan. O acervo cobre energia, sistemas elétricos, armazenamento (BESS), " +
  "geração solar, normas e regulação, e engenharia em geral. Responda em português, de forma direta e tecnicamente precisa, usando SOMENTE os trechos numerados fornecidos. " +
  "Depois de cada afirmação, cite a fonte com o número do trecho entre colchetes, como [2] ou [1][4]. Preserve números, unidades, siglas e nomes de normas exatamente como estão nos trechos. " +
  "Se os trechos não bastam para responder, diga claramente o que não foi encontrado e responda só a parte coberta; nunca complete com conhecimento de fora. " +
  "Use Markdown simples: parágrafos curtos, listas e negrito quando ajudar. Não repita a pergunta nem liste as fontes ao final.";

async function ask(b: any, db: SupabaseClient, save: boolean, provs: Prov[]) {
  const t0 = Date.now();
  const r = await retrieve({ ...b, expand: b.expand !== false, compare: false }, db, provs);
  let answer: string, model = "";
  if (!r.results.length) answer = "Não encontrei no acervo nenhum trecho relacionado a essa pergunta.";
  else {
    const ctx = r.results.map((x, i) => `[${i + 1}] ${x.title}${x.page ? " — página " + x.page : ""}${x.heading ? " — " + x.heading : ""}\n${x.content}`).join("\n\n");
    const hist = (Array.isArray(b.history) ? b.history.slice(-3) : []).map((h: any) => `Usuário: ${String(h.q).slice(0, 300)}\nAssistente: ${String(h.a).slice(0, 600)}`).join("\n");
    const g = await genAnswer({
      system: SYSTEM, temperature: 0.2,
      user: `Trechos do acervo:\n\n${ctx}\n\n${hist ? "Conversa até aqui:\n" + hist + "\n\n" : ""}Pergunta: ${String(b.q).trim()}`,
    }, provs, String(b.provider ?? ""));
    answer = g.text; model = g.model;
  }
  const ms = Date.now() - t0;
  if (save) {
    await db.from("brain_queries").insert({
      question: String(b.q).trim().slice(0, 2000), answer, ms,
      sources: r.results.map((x, i) => ({ n: i + 1, chunk_id: x.chunk_id, doc_id: x.doc_id, title: x.title, page: x.page })),
      params: { mode: b.mode ?? "hybrid", k: b.k ?? 8, w_sem: b.w_sem ?? 0.5, rerank: !!b.rerank, model },
    });
  }
  return { answer, sources: r.results, standalone: r.standalone, lex: r.lex, notice: r.notice, ms, model };
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
    image: { mime: b.mime, data: b.data }, temperature: 0,
    user: "Transcreva fielmente todo o texto desta imagem, na ordem de leitura. Para tabelas, preserve linhas e colunas. Para figuras, diagramas e gráficos, descreva o que mostram, com valores, unidades e legendas. Não comente nem resuma: devolva só o conteúdo.",
  });
  return { text: g.text };
}

// ---------- provedores (admin). A chave entra, mas nunca sai: a lista mostra só os 4 últimos caracteres ----------
const publicProv = (p: Prov) => ({ id: p.id, name: p.name, base_url: p.base_url, model: p.model, slot: p.slot, position: p.position,
  key_hint: p.api_key ? "…" + p.api_key.slice(-4) : "" });
async function providerSave(b: any, svc: SupabaseClient) {
  const id = String(b.id ?? "").trim().toLowerCase(), name = String(b.name ?? "").trim(), model = String(b.model ?? "").trim(), base = String(b.base_url ?? "").trim().replace(/\/+$/, "");
  if (!/^[a-z0-9-]{2,30}$/.test(id)) throw new Fail(400, "Identificador inválido: use de 2 a 30 letras minúsculas, números ou hífen.");
  if (!name || name.length > 60) throw new Fail(400, "Dê um nome de até 60 caracteres.");
  if (!model || model.length > 200) throw new Fail(400, "Informe o modelo.");
  let url: URL; try { url = new URL(base); } catch (_e) { throw new Fail(400, "URL base inválida."); }
  if (url.protocol !== "https:") throw new Fail(400, "A URL base precisa ser https.");
  if (!SLOTS.includes(b.slot)) throw new Fail(400, "Uso inválido.");
  const row: Record<string, unknown> = { id, name, base_url: base, model, slot: b.slot, position: Math.round(Number(b.position) || 0), updated_at: new Date().toISOString() };
  const key = typeof b.api_key === "string" ? b.api_key.trim() : "";
  if (key) { if (key.length > 400 || /\s/.test(key)) throw new Fail(400, "Chave inválida."); row.api_key = key; }   // vazio = mantém a chave guardada
  else if (b.clear_key) row.api_key = "";
  const { data, error } = await svc.from("brain_providers").upsert(row, { onConflict: "id" }).select("*").single();
  if (error) throw new Fail(500, /brain_providers/.test(error.message) ? "Tabela de provedores ausente: rode de novo o sql/setup.sql." : error.message);
  return publicProv(data as Prov);
}
async function providerGet(id: unknown, svc: SupabaseClient): Promise<Prov> {
  const { data } = await svc.from("brain_providers").select("*").eq("id", String(id ?? "")).maybeSingle();
  if (!data) throw new Fail(404, "Provedor não encontrado. Salve antes de testar.");
  return data as Prov;
}
async function providerTest(b: any, svc: SupabaseClient) {
  const p = await providerGet(b.id, svc), t0 = Date.now();
  const text = await chat(p, "", "Responda apenas com a palavra: ok", 0, 30000);
  return { ok: !!text, ms: Date.now() - t0, sample: text.slice(0, 120) };
}
async function providerModels(b: any, svc: SupabaseClient) {
  const p = await providerGet(b.id, svc);
  let r: Response;
  try { r = await fetch(modelsUrl(p.base_url), { headers: p.api_key ? { authorization: `Bearer ${p.api_key}` } : {}, signal: AbortSignal.timeout(15000) }); }
  catch (_e) { throw new Fail(504, `${p.name} não respondeu à lista de modelos.`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Fail(502, `${p.name} não listou os modelos (${r.status}): ${errText(j).slice(0, 160)}`);
  const ids = (Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []).map((m: any) => String(m?.id ?? m)).filter(Boolean);
  return { models: [...new Set<string>(ids)].sort().slice(0, 1000) };
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
    const provs = ["search", "ask", "whoami", "providers_list"].includes(b.action) ? await loadProviders(svc) : [];
    switch (b.action) {
      case "search": out = await retrieve(b, db, provs); break;
      case "ask": out = await ask(b, db, !!uid, provs); break;
      case "providers_list": needAdmin(); out = { providers: provs.map(publicProv) }; break;
      case "provider_save": needAdmin(); out = await providerSave(b, svc); break;
      case "provider_delete": needAdmin(); { const { error } = await svc.from("brain_providers").delete().eq("id", String(b.id ?? "")); if (error) throw new Fail(500, error.message); out = { ok: true }; } break;
      case "provider_test": needAdmin(); out = await providerTest(b, svc); break;
      case "provider_models": needAdmin(); out = await providerModels(b, svc); break;
      case "ingest_start": needAdmin(); out = await ingestStart(b, svc, uid); break;
      case "ingest_chunks": needAdmin(); out = await ingestChunks(b, svc); break;
      case "ingest_finish": needAdmin(); out = await ingestFinish(b, svc); break;
      case "delete_doc": needAdmin(); out = await deleteDoc(b, svc); break;
      case "describe": needAdmin(); out = await describe(b); break;
      // quem usa o Brain vê nome e modelo dos provedores com chave, para escolher na pergunta; a chave não sai daqui
      case "whoami": out = { admin, models: { embed: EMB, gen: GEN, lite: LITE, dim: DIM, chain: GEN_CHAIN, gemini_key: !!GEMINI },
        providers: provs.filter((p) => p.api_key).map((p) => ({ id: p.id, name: p.name, model: p.model, slot: p.slot })) }; break;
      default: throw new Fail(400, "Ação desconhecida.");
    }
    return new Response(JSON.stringify(out), { headers: H });
  } catch (e) {
    const status = e instanceof Fail ? e.status : 500;
    if (status >= 500) console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Erro inesperado." }), { status, headers: H });
  }
});
