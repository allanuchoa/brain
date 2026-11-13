// Interface do Allan's Brain. A busca roda no banco e na função de borda `brain`; aqui só se pergunta e se desenha.
// Indexação (admin): o texto do PDF é extraído neste navegador (pdf.js), fatiado por BR.chunkPages e enviado em lotes.
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = BR.esc, sb = getSupabaseClient();
  const FN = CONFIG.SUPABASE_URL + '/functions/v1/brain', LS = 'brain.opts', BUCKET = 'brain';
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const f0 = v => (+v || 0).toLocaleString('pt-BR');

  const DEF = { expand: true, rerank: false, k: 8, w: 0.5, mode: 'hybrid' };
  function loadOpts() {
    let s = {}; try { s = JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { s = {}; }
    const o = { ...DEF };
    for (const k in DEF) if (typeof s[k] === typeof DEF[k]) o[k] = s[k];
    if (!['hybrid', 'semantic', 'lexical', 'compare'].includes(o.mode)) o.mode = 'hybrid';
    o.w = Math.min(Math.max(o.w, 0), 1);
    return o;
  }
  const S = { o: loadOpts(), docs: [], byId: {}, filter: null, admin: false, conv: [], turns: [], evals: [], busy: false };
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(S.o)); } catch (e) { /* sem armazenamento: segue sem lembrar */ } };
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500); }
  function banner(msg) { const b = $('#banner'); b.textContent = msg || ''; b.hidden = !msg; }

  async function api(action, body) {
    const { data } = await sb.auth.getSession(), tok = data.session && data.session.access_token;
    if (!tok) throw new Error('Sem sessão. Entre pelo portal.');
    const r = await fetch(FN, { method: 'POST', headers: { authorization: 'Bearer ' + tok, apikey: CONFIG.SUPABASE_ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.message || 'Erro ' + r.status);
    return j;
  }
  const params = () => ({ k: S.o.k, w_sem: S.o.w, expand: S.o.expand, rerank: S.o.rerank, docs: S.filter ? [...S.filter] : null });

  // ---------- trechos encontrados ----------
  function card(r, n, ts) {
    const tags = [r.sem_rank ? 'semântica nº ' + r.sem_rank : '', r.lex_rank ? 'textual nº ' + r.lex_rank : '', r.rerank != null ? 'nota ' + r.rerank : ''].filter(Boolean);
    return '<article class="card" id="src-' + n + '"><header><span class="num">' + n + '</span><div><strong>' + esc(r.title) + '</strong>' +
      '<small>' + (r.page ? 'página ' + r.page : 'sem página') + (r.heading ? ' · ' + esc(r.heading) : '') + '</small></div></header>' +
      '<p class="snip">' + BR.highlight(BR.snippet(r.content, ts, 420), ts) + '</p><p class="snip full" hidden>' + BR.highlight(r.content, ts) + '</p>' +
      '<footer>' + tags.map(t => '<span class="tag">' + t + '</span>').join('') +
      '<button type="button" class="link" data-more>Ver trecho inteiro</button>' +
      (S.byId[r.doc_id] && S.byId[r.doc_id].storage_path ? '<button type="button" class="link" data-open="' + esc(r.doc_id) + '" data-page="' + (r.page || 1) + '">Abrir na página</button>' : '') + '</footer></article>';
  }
  const cards = (list, ts) => list.length ? list.map((r, i) => card(r, i + 1, ts)).join('') : '<p class="hint">Nenhum trecho encontrado.</p>';

  async function openDoc(id, page) {
    const d = S.byId[id]; if (!d || !d.storage_path) return toast('O arquivo original não está guardado.');
    const w = window.open('', '_blank');   // abre já, dentro do clique, para o navegador não bloquear
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(d.storage_path, 3600);
    if (error || !data) { if (w) w.close(); return toast('Não consegui abrir o arquivo.'); }
    const url = data.signedUrl + (d.mime === 'application/pdf' ? '#page=' + page : '');
    if (w) w.location = url; else location.href = url;
  }

  // ---------- perguntar ----------
  function bubble(cls, html) {
    const hello = $('#msgs .hello'); if (hello) hello.remove();
    const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = html; $('#msgs').appendChild(d); d.scrollIntoView({ block: 'end', behavior: 'smooth' });
    return d;
  }
  function showSources(i) {
    const t = S.turns[i]; if (!t) return;
    side('src'); $('#sources').innerHTML = '<p class="hint">Fontes da resposta a: ' + esc(t.q.slice(0, 90)) + '</p>' + cards(t.sources, t.terms);
  }
  function addTurn(q, answer, sources, extra) {
    const i = S.turns.push({ q, sources, terms: BR.terms(q + ' ' + (extra || '')) }) - 1;
    return { i, html: BR.md(answer, sources.length) };
  }
  async function ask(q) {
    q = q.trim(); if (!q || S.busy) return;
    S.busy = true; $('#ask-go').disabled = true; $('#ask-q').value = '';
    bubble('user', esc(q));
    const b = bubble('bot pending', 'Buscando no acervo e escrevendo a resposta…');
    try {
      const r = await api('ask', { q, history: S.conv.slice(-3), mode: 'hybrid', ...params() });
      const t = addTurn(q, r.answer, r.sources, r.lex);
      b.className = 'msg bot'; b.dataset.turn = t.i;
      b.innerHTML = t.html + '<p class="meta">' + r.sources.length + ' trechos · ' + (r.ms / 1000).toFixed(1).replace('.', ',') + ' s' + (r.model ? ' · ' + esc(r.model) : '') +
        (r.standalone && BR.norm(r.standalone) !== BR.norm(q) ? ' · entendi como: ' + esc(r.standalone) : '') + '</p>';
      S.conv.push({ q, a: r.answer }); showSources(t.i);
    } catch (e) { b.className = 'msg bot error'; b.textContent = 'Não consegui responder: ' + e.message; }
    S.busy = false; $('#ask-go').disabled = false; $('#ask-q').focus();
  }
  async function loadHistory() {
    const { data, error } = await sb.from('brain_queries').select('id, question, answer, sources, created_at').order('created_at', { ascending: false }).limit(60);
    $('#history').innerHTML = error ? '<p class="hint">Não consegui ler o histórico.</p>' : !data.length ? '<p class="hint">Nenhuma pergunta ainda.</p>'
      : data.map(h => '<div class="hist"><button type="button" class="link" data-hist="' + h.id + '">' + esc(h.question.slice(0, 120)) + '</button><small>' +
        new Date(h.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) +
        '</small><button type="button" class="x" data-hdel="' + h.id + '" aria-label="Apagar do histórico">✕</button></div>').join('');
    S.hist = data || [];
  }
  async function reopen(id) {
    const h = (S.hist || []).find(x => String(x.id) === String(id)); if (!h) return;
    const ids = (h.sources || []).map(s => s.chunk_id), { data } = await sb.from('brain_chunks').select('id, doc_id, page, heading, content').in('id', ids.length ? ids : [-1]);
    const by = {}; (data || []).forEach(c => { by[c.id] = c; });
    const sources = (h.sources || []).map(s => { const c = by[s.chunk_id] || {}; return { doc_id: s.doc_id, title: s.title, page: s.page, heading: c.heading, content: c.content || '(trecho removido do acervo)' }; });
    bubble('user', esc(h.question));
    const t = addTurn(h.question, h.answer || '', sources), b = bubble('bot', t.html + '<p class="meta">do histórico</p>');
    b.dataset.turn = t.i; S.conv.push({ q: h.question, a: h.answer || '' }); showSources(t.i);
  }
  function side(which) {
    $$('[data-side]').forEach(b => b.setAttribute('aria-pressed', b.dataset.side === which));
    $('#sources').hidden = which !== 'src'; $('#history').hidden = which !== 'hist';
    if (which === 'hist') loadHistory();
  }

  // ---------- buscar ----------
  async function search(q) {
    q = q.trim(); if (!q) return;
    const box = $('#results'), cmp = S.o.mode === 'compare';
    box.innerHTML = '<p class="hint">Buscando…</p>'; $('#search-info').textContent = '';
    try {
      const r = await api('search', { q, mode: cmp ? 'hybrid' : S.o.mode, compare: cmp, ...params(), rerank: cmp ? false : S.o.rerank });
      const ts = BR.terms(q + ' ' + (r.extra || []).join(' '));
      $('#search-info').textContent = 'Consulta textual usada: ' + (r.lex || '(vazia)') + (r.standalone && BR.norm(r.standalone) !== BR.norm(q) ? ' · pergunta reescrita: ' + r.standalone : '');
      box.innerHTML = cmp
        ? '<div class="cmp">' + [['semantic', 'Semântica', 'acha pelo significado'], ['lexical', 'Textual', 'acha pelo termo exato'], ['hybrid', 'Híbrida', 'funde as duas']].map(([k, t, d]) =>
            '<div><h3>' + t + '</h3><p class="hint">' + d + ' · ' + r.lists[k].length + ' trechos</p><div class="cards">' + cards(r.lists[k], ts) + '</div></div>').join('') + '</div>'
        : '<div class="cards wide">' + cards(r.results, ts) + '</div>';
    } catch (e) { box.innerHTML = '<p class="hint error">Não consegui buscar: ' + esc(e.message) + '</p>'; }
  }

  // ---------- acervo ----------
  async function loadDocs() {
    const { data, error } = await sb.from('brain_documents').select('*').order('title');
    if (error) { banner('Não consegui ler o acervo: ' + error.message); return; }
    S.docs = data || []; S.byId = {}; S.docs.forEach(d => { S.byId[d.id] = d; });
    const ready = S.docs.filter(d => d.status === 'ready'), sum = k => ready.reduce((s, d) => s + (d[k] || 0), 0);
    $('#doc-stats').innerHTML = [['Documentos', ready.length], ['Páginas', sum('pages')], ['Trechos indexados', sum('chunks')], ['Páginas sem texto', sum('blank_pages')]]
      .map(([l, v]) => '<div class="tile"><small>' + l + '</small><strong>' + f0(v) + '</strong></div>').join('');
    const ST = { ready: ['on', '● Pronto'], indexing: ['wait', '◌ Indexando'], error: ['off', '✕ Falhou'] };
    $('#doc-table').innerHTML = '<thead><tr><th>Documento</th><th>Categoria</th><th class="r">Páginas</th><th class="r">Trechos</th><th class="r">Sem texto</th><th>Situação</th><th>Ações</th></tr></thead><tbody>' +
      (S.docs.length ? S.docs.map(d => '<tr><td><strong>' + esc(d.title) + '</strong><br><small>' + esc(d.file_name) + '</small></td><td>' + esc(d.category || '') + '</td><td class="r">' + f0(d.pages) + '</td><td class="r">' + f0(d.chunks) +
        '</td><td class="r">' + f0(d.blank_pages) + '</td><td><span class="badge ' + ST[d.status][0] + '">' + ST[d.status][1] + '</span></td><td class="actions">' +
        (d.storage_path ? '<button type="button" data-open="' + d.id + '" data-page="1">Abrir</button>' : '') + (S.admin ? '<button type="button" data-del="' + d.id + '">Excluir</button>' : '') + '</td></tr>').join('')
        : '<tr><td colspan="7">O acervo está vazio.</td></tr>') + '</tbody>';
    const cats = [...new Set(S.docs.map(d => d.category).filter(Boolean))].sort();
    $('#cats').innerHTML = cats.map(c => '<option value="' + esc(c) + '">').join('');
    $('#doc-checks').innerHTML = ready.map(d => '<label class="chk"><input type="checkbox" value="' + d.id + '"' + (!S.filter || S.filter.has(d.id) ? ' checked' : '') + '> ' + esc(d.title) + '</label>').join('');
    $('#eval-doc').innerHTML = '<option value="">Documento esperado…</option>' + ready.map(d => '<option value="' + d.id + '">' + esc(d.title.slice(0, 80)) + '</option>').join('');
    filterLabel();
  }
  function filterLabel() {
    const n = S.docs.filter(d => d.status === 'ready').length;
    $('#doc-filter-label').textContent = !S.filter || S.filter.size === n ? 'Todos os documentos' : S.filter.size + ' de ' + n + ' documentos';
  }
  function readFilter() {
    const all = $$('#doc-checks input'), on = all.filter(c => c.checked);
    S.filter = on.length === all.length ? null : new Set(on.map(c => c.value)); filterLabel();
  }

  // ---------- indexação no navegador (admin) ----------
  let pdfReady = null;
  function loadPdfjs() {
    return pdfReady || (pdfReady = new Promise((ok, no) => {
      const s = document.createElement('script'); s.src = PDFJS + 'pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
      s.onerror = () => { pdfReady = null; no(new Error('Não consegui carregar o leitor de PDF.')); };
      document.head.appendChild(s);
    }));
  }
  const b64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  async function ingest(file, say) {
    if (file.size > 50 * 1024 * 1024) throw new Error('arquivo acima de 50 MB');
    const buf = await file.arrayBuffer(), ext = (file.name.split('.').pop() || '').toLowerCase(), ocr = $('#ocr').checked;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
    const pages = []; let blank = 0, mime = file.type || 'application/octet-stream';
    if (ext === 'pdf') {
      mime = 'application/pdf';
      const doc = await (await loadPdfjs()).getDocument({ data: buf.slice(0) }).promise;
      for (let i = 1; i <= doc.numPages; i++) {
        say('lendo página ' + i + ' de ' + doc.numPages);
        const page = await doc.getPage(i); let text = BR.pageText((await page.getTextContent()).items);
        if (text.length < 80) {
          blank++;
          if (ocr) {   // página digitalizada: vira imagem e o Gemini transcreve
            const vp = page.getViewport({ scale: 1.6 }), cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
            await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
            text = (await api('describe', { mime: 'image/jpeg', data: cv.toDataURL('image/jpeg', 0.85).split(',')[1] })).text || text;
          }
        }
        pages.push({ n: i, text });
      }
    } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
      mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      say('descrevendo a imagem com IA'); pages.push({ n: 1, text: (await api('describe', { mime, data: b64(buf) })).text });
    } else { mime = 'text/plain'; pages.push({ n: 1, text: await file.text() }); }

    const chunks = BR.chunkPages(pages);
    if (!chunks.length) throw new Error('nenhum texto extraído' + (ext === 'pdf' && !ocr ? ' (marque "Ler páginas digitalizadas")' : ''));
    const path = hash.slice(0, 16) + '.' + ext;
    say('enviando o arquivo original');
    const up = await sb.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: mime });
    if (up.error) throw new Error('envio do arquivo: ' + up.error.message);
    const title = file.name.replace(/\.[^.]+$/, '').replace(/[_+]+/g, ' ').trim();
    const start = await api('ingest_start', { title, file_name: file.name, storage_path: path, mime, category: $('#up-cat').value.trim() || null,
      pages: pages.length, blank_pages: blank, chars: pages.reduce((s, p) => s + p.text.length, 0), content_hash: hash });
    if (start.duplicate) return 'já estava no acervo';
    for (let i = 0; i < chunks.length; i += 48) {
      const label = 'indexando trechos ' + Math.min(i + 48, chunks.length) + ' de ' + chunks.length;
      for (let t = 1; ; t++) {   // a cota de embeddings do Gemini é por minuto: espera e repete
        say(label);
        try { await api('ingest_chunks', { doc_id: start.id, chunks: chunks.slice(i, i + 48) }); break; }
        catch (e) { if (t >= 10 || !/Limite por minuto|Erro 5\d\d|demorou/.test(e.message)) throw e; say(label + ' (aguardando a cota do Gemini, 65 s)'); await new Promise(r => setTimeout(r, 65000)); }
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    const fin = await api('ingest_finish', { doc_id: start.id });
    return fin.chunks + ' trechos em ' + pages.length + ' página(s)';
  }
  let queue = Promise.resolve();
  function addFiles(files) {
    for (const f of files) {
      const row = document.createElement('div'); row.className = 'job'; row.innerHTML = '<strong>' + esc(f.name) + '</strong><span>na fila</span>'; $('#jobs').prepend(row);
      const say = t => { row.lastChild.textContent = t; };
      queue = queue.then(() => ingest(f, say)).then(r => { row.classList.add('ok'); say('✓ ' + r); return loadDocs(); }, e => { row.classList.add('bad'); say('✕ ' + e.message); });
    }
  }

  // ---------- avaliação ----------
  async function loadEval() {
    const { data, error } = await sb.from('brain_eval').select('*').order('id');
    S.evals = error ? [] : data || []; drawEval(null);
  }
  function drawEval(pos) {   // pos: {idDaPergunta: {semantic, lexical, hybrid}} com a posição do acerto (0 = não achou)
    const cell = v => v == null ? '' : v ? '<span class="badge on">nº ' + v + '</span>' : '<span class="badge off">✕ não achou</span>';
    $('#eval-table').innerHTML = '<thead><tr><th>Pergunta</th><th>Resposta esperada em</th>' + (pos ? '<th>Semântica</th><th>Textual</th><th>Híbrida</th>' : '') + (S.admin ? '<th></th>' : '') + '</tr></thead><tbody>' +
      (S.evals.length ? S.evals.map(e => { const d = S.byId[e.expect_doc], p = pos && pos[e.id];
        return '<tr><td>' + esc(e.question) + '</td><td>' + esc(d ? d.title : '(documento removido)') + (e.expect_page ? ', p. ' + e.expect_page : '') + '</td>' +
          (pos ? '<td>' + cell(p && p.semantic) + '</td><td>' + cell(p && p.lexical) + '</td><td>' + cell(p && p.hybrid) + '</td>' : '') +
          (S.admin ? '<td class="actions"><button type="button" data-edel="' + e.id + '">Excluir</button></td>' : '') + '</tr>'; }).join('')
        : '<tr><td colspan="6">Nenhuma pergunta de avaliação ainda.</td></tr>') + '</tbody>';
  }
  async function runEval() {
    if (!S.evals.length) return toast('Adicione perguntas de avaliação primeiro.');
    const runs = { semantic: [], lexical: [], hybrid: [] }, pos = {}, btn = $('#eval-run'); btn.disabled = true;
    for (const [i, e] of S.evals.entries()) {
      $('#eval-prog').textContent = 'Pergunta ' + (i + 1) + ' de ' + S.evals.length + '…';
      try {
        const r = await api('search', { q: e.question, compare: true, k: 5, w_sem: S.o.w, expand: S.o.expand, docs: null });
        pos[e.id] = {};
        for (const m of Object.keys(runs)) {
          runs[m].push({ expectDoc: e.expect_doc, expectPage: e.expect_page, results: r.lists[m] });
          pos[e.id][m] = r.lists[m].findIndex(x => x.doc_id === e.expect_doc && (e.expect_page == null || Math.abs((x.page || 0) - e.expect_page) <= 1)) + 1;
        }
      } catch (err) { $('#eval-prog').textContent = 'Falhou na pergunta ' + (i + 1) + ': ' + err.message; btn.disabled = false; return; }
    }
    const pc = v => f0(Math.round(v)) + ' %';
    $('#eval-summary').innerHTML = [['semantic', 'Semântica'], ['lexical', 'Textual'], ['hybrid', 'Híbrida']].map(([k, t]) => { const m = BR.metrics(runs[k]);
      return '<div class="tile"><small>' + t + '</small><strong>' + pc(m.hit[1]) + '</strong><em>certo em 1º · ' + pc(m.hit[3]) + ' entre os 3 · ' + pc(m.hit[5]) + ' entre os 5 · MRR ' + m.mrr.toFixed(2).replace('.', ',') + '</em></div>'; }).join('');
    $('#eval-prog').textContent = S.evals.length + ' perguntas, peso semântico ' + S.o.w.toFixed(2).replace('.', ',') + (S.o.expand ? ', com expansão' : ', sem expansão') + '.';
    drawEval(pos); btn.disabled = false;
  }

  // ---------- interface ----------
  function ui() {
    $$('[data-o]').forEach(el => { if (el.type === 'checkbox') el.checked = S.o[el.dataset.o]; else el.value = S.o[el.dataset.o]; });
    $('#w-out').textContent = Math.round(S.o.w * 100) + ' %';
    $$('[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === S.o.mode));
  }
  function tab(t) {
    $$('#tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
    $$('.tab').forEach(s => { s.hidden = s.id !== 'tab-' + t; });
    $('#opts').hidden = t === 'docs';
    if (t === 'eval') loadEval();
  }

  async function init() {
    ui();
    $('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) tab(b.dataset.tab); });
    document.addEventListener('input', e => {
      const el = e.target, k = el.dataset.o; if (!k) return;
      S.o[k] = el.type === 'checkbox' ? el.checked : +el.value; save(); ui();
    });
    $('#doc-checks').addEventListener('change', readFilter);
    $('#doc-all').addEventListener('click', () => { $$('#doc-checks input').forEach(c => { c.checked = true; }); readFilter(); });
    $('#doc-none').addEventListener('click', () => { $$('#doc-checks input').forEach(c => { c.checked = false; }); readFilter(); });

    $('#ask-form').addEventListener('submit', e => { e.preventDefault(); ask($('#ask-q').value); });
    $('#ask-q').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('#ask-q').value); } });
    $('#ask-new').addEventListener('click', () => { S.conv = []; S.turns = []; $('#msgs').innerHTML = '<p class="hint">Nova conversa. As próximas perguntas não usam o contexto das anteriores.</p>'; $('#sources').innerHTML = ''; $('#ask-q').focus(); });
    $('#examples').addEventListener('click', e => { const b = e.target.closest('button'); if (b) ask(b.textContent); });
    $$('[data-side]').forEach(b => b.addEventListener('click', () => side(b.dataset.side)));

    $('#search-form').addEventListener('submit', e => { e.preventDefault(); search($('#search-q').value); });
    $$('[data-mode]').forEach(b => b.addEventListener('click', () => { S.o.mode = b.dataset.mode; save(); ui(); if ($('#search-q').value.trim()) search($('#search-q').value); }));

    document.addEventListener('click', async e => {
      const t = e.target, cite = t.closest('.cite'), open = t.closest('[data-open]'), more = t.closest('[data-more]');
      if (cite) {
        const m = cite.closest('.msg'); if (m && m.dataset.turn != null) showSources(+m.dataset.turn);
        const c = $('#src-' + cite.dataset.n, $('#sources')); if (c) { c.scrollIntoView({ block: 'center', behavior: 'smooth' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1600); }
      } else if (open) openDoc(open.dataset.open, open.dataset.page);
      else if (more) { const a = more.closest('.card'), full = $('.full', a), on = full.hidden; full.hidden = !on; full.previousElementSibling.hidden = on; more.textContent = on ? 'Ver só o recorte' : 'Ver trecho inteiro'; }
      else if (t.dataset.hist) reopen(t.dataset.hist);
      else if (t.dataset.hdel) { await sb.from('brain_queries').delete().eq('id', t.dataset.hdel); loadHistory(); }
      else if (t.dataset.del) {
        const d = S.byId[t.dataset.del];
        if (!confirm('Excluir "' + d.title + '" do acervo? Os trechos e o arquivo original são apagados e isso não pode ser desfeito.')) return;
        try { await api('delete_doc', { doc_id: d.id }); toast('Documento excluído.'); loadDocs(); } catch (err) { toast('Não consegui excluir: ' + err.message); }
      } else if (t.dataset.edel) { const r = await sb.from('brain_eval').delete().eq('id', t.dataset.edel); if (r.error) toast('Não consegui excluir.'); loadEval(); }
    });

    $('#file').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
    const drop = $('#drop');
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });
    ['dragenter', 'dragover'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });

    $('#eval-form').addEventListener('submit', async e => {
      e.preventDefault();
      const r = await sb.from('brain_eval').insert({ question: $('#eval-q').value.trim(), expect_doc: $('#eval-doc').value, expect_page: +$('#eval-page').value || null });
      if (r.error) return toast('Não consegui adicionar: ' + r.error.message);
      $('#eval-q').value = ''; $('#eval-page').value = ''; loadEval();
    });
    $('#eval-run').addEventListener('click', runEval);

    if (sb) sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') window.location.href = CONFIG.PORTAL_URL; });
    try {
      const me = await api('whoami', {});
      S.admin = !!me.admin; $('#admin-up').hidden = !S.admin; $('#eval-form').hidden = !S.admin;
    } catch (e) { banner(e.message); }
    await loadDocs();
  }
  init();
})();
