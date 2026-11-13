// Carga em lote do acervo, fora do navegador. Usa o mesmo fatiador (engine.js) e a mesma função de borda.
// Uso:  BRAIN_SERVICE_KEY=<service_role> node tools/seed.mjs "<pasta com PDFs>" [filtro do nome]
// Requer pdfjs-dist instalado onde o Node encontre (npm i pdfjs-dist@3.11.174). A chave nunca vai para o repositório.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const BR = require('../engine.js');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const URL_ = process.env.BRAIN_URL || 'https://bursmepgqsdhfgrpbtrf.supabase.co', KEY = process.env.BRAIN_SERVICE_KEY;
const dir = process.argv[2], only = (process.argv[3] || '').toLowerCase();
if (!KEY || !dir) { console.error('Informe BRAIN_SERVICE_KEY e a pasta.'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A cota de embeddings do Gemini é por minuto: em 429 (ou 5xx) espera um minuto e tenta de novo.
async function api(body, tries = 12) {
  for (let i = 1; ; i++) {
    const r = await fetch(`${URL_}/functions/v1/brain`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    if (/diária/.test(j.error || '')) { console.log(' PAROU: ' + j.error); process.exit(2); }   // cota do dia: não adianta insistir
    if (i >= tries || r.status < 500 && r.status !== 429) throw new Error(`${body.action}: ${r.status} ${j.error || ''}`);
    process.stdout.write(r.status === 429 ? ' (cota, 65s) ' : ` (${r.status}, 65s) `); await sleep(65000);
  }
}
const cleanTitle = f => decodeURIComponent(f.replace(/\.pdf$/i, '').replace(/%(?![0-9a-f]{2})/gi, '%25')).replace(/[+_]+/g, ' ').replace(/^\d{8,}\s*/, '').replace(/\s*\(\d+\)$/, '').replace(/\s+/g, ' ').trim();
const category = t => /\b(nbr|iec|prodist|ren\b|resolu|lei\b|portaria|ged-)/i.test(t) ? 'Normas e regulação' : /\b(lrcap|epe|ons|leil)/i.test(t) ? 'Planejamento e leilões' : 'Referência técnica';

const files = (await readdir(dir)).filter(f => /\.pdf$/i.test(f) && (!only || f.toLowerCase().includes(only))).sort();
let totalChunks = 0;
for (const [n, f] of files.entries()) {
  const t0 = Date.now(), buf = await readFile(path.join(dir, f)), hash = createHash('sha256').update(buf).digest('hex');
  const title = cleanTitle(f);
  process.stdout.write(`[${n + 1}/${files.length}] ${title.slice(0, 70)} ... `);
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0 }).promise;
    const pages = []; let blank = 0, chars = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const text = BR.pageText((await (await doc.getPage(i)).getTextContent()).items);
      if (text.length < 80) blank++;
      chars += text.length; pages.push({ n: i, text });
    }
    const chunks = BR.chunkPages(pages);
    const storagePath = `${hash.slice(0, 16)}.pdf`;
    const up = await fetch(`${URL_}/storage/v1/object/brain/${storagePath}`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/pdf', 'x-upsert': 'true' }, body: buf });
    if (!up.ok) throw new Error('upload: ' + up.status + ' ' + (await up.text()).slice(0, 120));
    const start = await api({ action: 'ingest_start', title, file_name: f, storage_path: storagePath, mime: 'application/pdf', category: category(title), pages: doc.numPages, blank_pages: blank, chars, content_hash: hash });
    if (start.duplicate) { console.log('já indexado'); continue; }
    for (let i = 0; i < chunks.length; i += 48) { await api({ action: 'ingest_chunks', doc_id: start.id, chunks: chunks.slice(i, i + 48) }); await sleep(6000); }   // ritmo abaixo da cota por minuto
    const fin = await api({ action: 'ingest_finish', doc_id: start.id });
    totalChunks += fin.chunks;
    console.log(`${doc.numPages} pág, ${fin.chunks} trechos, ${blank} sem texto, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (e) { console.log('ERRO: ' + e.message); }
}
console.log(`FIM: ${files.length} arquivos, ${totalChunks} trechos novos.`);
