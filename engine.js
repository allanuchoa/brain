// Motor puro (sem DOM, sem rede): texto de página, fatiamento em trechos, realce, Markdown e métricas.
// Exporta BR (navegador e Node). A busca em si roda no banco (sql/setup.sql) e na função de borda.
(function (root) {
  'use strict';
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- extração: itens de texto do pdf.js -> linhas ----------
  function pageText(items) {
    let out = '', lastY = null;
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      const y = it.transform ? it.transform[5] : null;
      if (lastY != null && y != null && Math.abs(y - lastY) > 2 && out && !out.endsWith('\n')) out += '\n';
      out += it.str;
      if (it.hasEOL) out += '\n';
      if (y != null) lastY = y;
    }
    return out.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------- fatiamento ----------
  const HEAD = /^(\d{1,2}(\.\d{1,3}){0,4}\.?\s+\S|(cap[ií]tulo|se[cç][aã]o|anexo|ap[eê]ndice|chapter|section|appendix|part|t[ií]tulo)\s+[\divxlc]+\b|art\.?\s*\d+)/i;
  function isHeading(line) {
    const t = line.trim();
    if (t.length < 4 || t.length > 110 || /[.;,:]$/.test(t) && !/^art/i.test(t)) return false;
    if (HEAD.test(t)) return !/^\d+([.,]\d+)*\s*(%|kw|mw|kv|v|a|hz|r\$|kwh|mwh)\b/i.test(t);   // "10 kW ..." não é título
    const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
    return letters.length >= 8 && t === t.toUpperCase() && t.split(/\s+/).length >= 2 && t.split(/\s+/).length <= 14;
  }
  const headingLabel = line => { const t = line.trim(), m = t.match(/^art\.?\s*\d+[º°o]?(-[A-Z])?/i); return (m ? m[0] : t).slice(0, 110); };

  // cabeçalhos e rodapés: a mesma linha (sem os dígitos) repetida em muitas páginas
  function repeated(pages) {
    const seen = new Map();
    for (const p of pages) {
      const ls = p.text.split('\n').map(l => l.trim()).filter(Boolean), edge = new Set([...ls.slice(0, 3), ...ls.slice(-3)].map(l => norm(l).replace(/\d+/g, '#')));
      edge.forEach(k => { if (k.length > 3 && k.length <= 80) seen.set(k, (seen.get(k) || 0) + 1); });   // rodapé é curto; frase longa repetida é conteúdo
    }
    const min = Math.max(4, pages.length * 0.4), out = new Set();
    seen.forEach((n, k) => { if (n >= min) out.add(k); });
    return out;
  }

  // pages: [{n, text}] -> [{page, idx, heading, content}]. Um trecho nunca cruza páginas, para a citação ser exata.
  function chunkPages(pages, opt) {
    const size = (opt && opt.size) || 1200, overlap = (opt && opt.overlap) || 150, minLen = 40;
    const junk = repeated(pages), chunks = [];
    let heading = '';
    for (const p of pages) {
      // \0 sai porque o Postgres recusa \u0000 em texto
      const lines = p.text.replace(/\0/g, '').replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2').split('\n').map(l => l.trim())
        .filter(l => l && !junk.has(norm(l).replace(/\d+/g, '#')) && !/^(p[aá]gina\s*)?\d{1,4}(\s*(de|\/|of)\s*\d{1,4})?$/i.test(l));
      // buf = linhas do trecho em montagem; as `carry` primeiras são sobreposição do trecho anterior
      let buf = [], carry = 0, len = 0, head = heading;
      const emit = last => {
        const fresh = buf.slice(carry).join('\n').trim(), content = buf.join('\n').trim(), prev = chunks[chunks.length - 1];
        if (fresh.length >= minLen) chunks.push({ page: p.n, idx: 0, heading: head || null, content });
        else if (fresh && prev && prev.page === p.n) prev.content += '\n' + fresh;   // sobra curta junta ao trecho anterior
        if (last) return;
        const keep = []; let k = 0;
        for (let i = buf.length - 1; i >= carry && k + buf[i].length <= overlap; i--) { keep.unshift(buf[i]); k += buf[i].length; }
        buf = fresh.length >= minLen ? keep : []; carry = buf.length; len = buf.reduce((s, l) => s + l.length + 1, 0); head = heading;
      };
      for (const raw of lines) {
        // linha maior que um trecho inteiro (PDF sem quebras): corta em pedaços no espaço
        const parts = raw.length > size ? raw.match(new RegExp('.{1,' + size + '}(\\s|$)', 'g')) || [raw] : [raw];
        for (const part of parts) {
          const l = part.trim(); if (!l) continue;
          const h = isHeading(l);
          if (h && len > size * 0.35) emit(false);           // título novo começa trecho novo, se o atual já tem corpo
          if (h) { heading = headingLabel(l); if (buf.length === carry) head = heading; }
          if (len + l.length > size && buf.length > carry) emit(false);
          buf.push(l); len += l.length + 1;
          if (len >= size * 0.8 && /[.!?:;]$/.test(l)) emit(false);   // fecha em fim de frase quando já está cheio
        }
      }
      emit(true);
    }
    chunks.forEach((c, i) => { c.idx = i; });
    return chunks;
  }

  // ---------- realce e recorte (insensível a acento) ----------
  const STOP = new Set('a o as os um uma de do da dos das em no na nos nas por para com sem que qual quais como quando onde e ou se ser foi tem ter ao aos sobre entre mais the of and or in on for to is are what which how'.split(' '));
  function terms(q) {
    const out = [];
    String(q || '').replace(/"([^"]+)"/g, (m, p) => { out.push(norm(p).trim()); return ' '; })
      .split(/\s+/).forEach(w => { const t = norm(w).replace(/^-.*$/, '').replace(/[^\p{L}\p{N}.\-/]/gu, '').replace(/^[.\-/]+|[.\-/]+$/g, ''); if (t.length >= 2 && !STOP.has(t)) out.push(t); });
    return [...new Set(out)].sort((a, b) => b.length - a.length);
  }
  // posições de cada termo no texto; norm() preserva o comprimento em caracteres compostos comuns (á -> a)
  function ranges(text, ts) {
    const base = norm(text), hits = [];
    if (base.length !== text.length) return hits;   // texto com caractere que muda de tamanho: sem realce, sem erro
    for (const t of ts) {
      const stem = t.length > 4 && !/[\d\s]/.test(t) ? t.replace(/(es|s)$/, '') : t;   // plural simples; o resto da palavra é casado até o fim
      let i = 0;
      while ((i = base.indexOf(stem, i)) >= 0) {
        if (i === 0 || !/[\p{L}\p{N}]/u.test(base[i - 1])) { let e = i + stem.length; while (e < base.length && /[\p{L}\p{N}]/u.test(base[e])) e++; hits.push([i, e]); }
        i += stem.length;
      }
    }
    hits.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const h of hits) { const last = out[out.length - 1]; if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]); else out.push(h.slice()); }
    return out;
  }
  function highlight(text, ts) {
    let out = '', pos = 0;
    for (const [a, b] of ranges(text, ts)) { out += esc(text.slice(pos, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>'; pos = b; }
    return out + esc(text.slice(pos));
  }
  function snippet(text, ts, len) {
    len = len || 320;
    const r = ranges(text, ts), start = r.length ? Math.max(0, r[0][0] - 80) : 0, cut = text.slice(start, start + len);
    return (start ? '… ' : '') + cut.trim() + (start + len < text.length ? ' …' : '');
  }

  // ---------- Markdown mínimo e seguro: tudo é escapado antes; citações [n] viram botões ----------
  function md(src, nSources) {
    const inline = s => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[(\d{1,2})\]/g, (m, n) => (+n >= 1 && +n <= (nSources || 0) ? '<button type="button" class="cite" data-n="' + n + '" aria-label="Fonte ' + n + '">' + n + '</button>' : m));
    const lines = String(src || '').replace(/\r/g, '').split('\n'), out = [];
    let list = null, para = [], table = null;
    const endPara = () => { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
    const endList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    const endTable = () => { if (table) { out.push('<div class="tbl-wrap"><table>' + table.map((r, i) => '<tr>' + r.map(c => (i ? '<td>' : '<th>') + inline(c) + (i ? '</td>' : '</th>')).join('') + '</tr>').join('') + '</table></div>'); table = null; } };
    for (const l of lines) {
      const t = l.trim(), h = t.match(/^(#{1,4})\s+(.*)$/), li = t.match(/^([-*•]|\d+[.)])\s+(.*)$/);
      if (/^\|.*\|$/.test(t)) { endPara(); endList(); if (!/^\|[\s:|-]+\|$/.test(t)) (table = table || []).push(t.slice(1, -1).split('|').map(c => c.trim())); continue; }
      endTable();
      if (!t) { endPara(); endList(); }
      else if (h) { endPara(); endList(); out.push('<h4>' + inline(h[2]) + '</h4>'); }
      else if (li) { endPara(); const kind = /^\d/.test(li[1]) ? 'ol' : 'ul'; if (list !== kind) { endList(); out.push('<' + kind + '>'); list = kind; } out.push('<li>' + inline(li[2]) + '</li>'); }
      else { endList(); para.push(inline(t)); }
    }
    endPara(); endList(); endTable();
    return out.join('');
  }

  // ---------- avaliação: runs = [{expectDoc, expectPage, results:[{doc_id, page}]}] ----------
  function metrics(runs, ks) {
    ks = ks || [1, 3, 5];
    const out = { n: runs.length, mrr: 0, hit: {}, page: 0 };
    ks.forEach(k => { out.hit[k] = 0; });
    for (const r of runs) {
      const pos = r.results.findIndex(x => x.doc_id === r.expectDoc && (r.expectPage == null || Math.abs((x.page || 0) - r.expectPage) <= 1));
      if (pos >= 0) { out.mrr += 1 / (pos + 1); ks.forEach(k => { if (pos < k) out.hit[k]++; }); }
    }
    if (runs.length) { out.mrr /= runs.length; ks.forEach(k => { out.hit[k] = out.hit[k] / runs.length * 100; }); }
    return out;
  }

  const BR = { norm, esc, pageText, isHeading, chunkPages, terms, highlight, snippet, md, metrics };
  if (typeof module !== 'undefined' && module.exports) module.exports = BR; else root.BR = BR;
})(typeof window !== 'undefined' ? window : globalThis);
