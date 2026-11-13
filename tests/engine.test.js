// Teste do motor. Rodar: node tests/engine.test.js
const assert = require('assert');
const BR = require('../engine.js');

// extração: itens do pdf.js viram linhas
assert.strictEqual(BR.pageText([{ str: 'Art. 1º', transform: [0, 0, 0, 0, 0, 700], hasEOL: true }, { str: 'O sistema ', transform: [0, 0, 0, 0, 0, 680] }, { str: 'deve operar.', transform: [0, 0, 0, 0, 0, 680] }]), 'Art. 1º\nO sistema deve operar.');

// títulos
['4.2 Requisitos de proteção', 'Art. 12', 'CAPÍTULO III', 'REQUISITOS GERAIS DE ACESSO', 'Chapter 5'].forEach(h => assert.ok(BR.isHeading(h), h));
['10 kW de potência instalada', 'O inversor deve desligar em até 2 segundos.', 'Tabela', 'ABC'].forEach(h => assert.ok(!BR.isHeading(h), h));

// fatiamento
const frase = 'O sistema de armazenamento deve atender aos requisitos de tensão e frequência definidos pelo operador.';
const corpo = n => Array.from({ length: n }, (_, i) => `${frase} Item ${i}.`).join('\n');
const pages = [
  { n: 1, text: 'Empresa X - Relatório\n1 Introdução\n' + corpo(20) + '\n1' },
  { n: 2, text: 'Empresa X - Relatório\n2 Requisitos\n' + corpo(6) + '\n2' },
  { n: 3, text: 'Empresa X - Relatório\ncurto\n3' },
  { n: 4, text: 'Empresa X - Relatório\n' + corpo(2) + '\n4' },
  { n: 5, text: 'Empresa X - Relatório\n' + corpo(2) + '\n5' },
];
const ch = BR.chunkPages(pages);
assert.ok(ch.length >= 4);
assert.ok(ch.every((c, i) => c.idx === i), 'idx em sequência');
assert.ok(ch.every(c => c.content.length <= 1500 && c.content.length >= 40), 'tamanho dos trechos');
assert.ok(ch.every(c => !/Empresa X/.test(c.content)), 'cabeçalho repetido removido');
assert.ok(ch.every(c => !/\n\d$/.test(c.content)), 'número de página removido');
assert.strictEqual(ch[0].heading, '1 Introdução');
assert.strictEqual(ch.find(c => c.page === 2).heading, '2 Requisitos');
assert.ok(!ch.some(c => c.page === 3), 'página quase vazia não vira trecho');
// todo o conteúdo novo aparece em algum trecho, e cada trecho fica numa página só
for (let i = 0; i < 20; i++) assert.ok(ch.some(c => c.page === 1 && c.content.includes(`Item ${i}.`)), 'item ' + i);
// linha gigante sem quebra também é fatiada
assert.ok(BR.chunkPages([{ n: 1, text: (frase + ' ').repeat(60) }]).length >= 4);
// hifenização de fim de linha é desfeita
assert.ok(BR.chunkPages([{ n: 1, text: 'A degrada-\nção das baterias depende da temperatura e da profundidade de descarga.' }])[0].content.includes('degradação'));

// termos, realce e recorte
assert.deepStrictEqual(BR.terms('Qual o limite de DRC na "REN 1000"?'), ['ren 1000', 'limite', 'drc']);
assert.strictEqual(BR.highlight('A degradação dos inversores <b>', BR.terms('degradacao inversor')), 'A <mark>degradação</mark> dos <mark>inversores</mark> &lt;b&gt;');
assert.strictEqual(BR.highlight('Lei 14.300 de 2022', BR.terms('14.300')), 'Lei <mark>14.300</mark> de 2022');
assert.ok(BR.snippet('x'.repeat(500) + ' bateria ' + 'y'.repeat(500), ['bateria']).includes('bateria'));

// markdown: escapa HTML, citações só dentro do número de fontes
const html = BR.md('**Limite**: 5% [1][9]\n\n- item <script>\n- outro\n\n| a | b |\n|---|---|\n| 1 | 2 |', 2);
assert.ok(html.includes('<strong>Limite</strong>') && html.includes('data-n="1"') && html.includes('[9]') && !html.includes('<script>'));
assert.ok(html.includes('<ul><li>item &lt;script&gt;</li><li>outro</li></ul>') && html.includes('<th>a</th>') && html.includes('<td>2</td>'));

// métricas de avaliação
const m = BR.metrics([
  { expectDoc: 'A', expectPage: 10, results: [{ doc_id: 'B', page: 1 }, { doc_id: 'A', page: 11 }] },   // acerto na posição 2 (página vizinha vale)
  { expectDoc: 'A', expectPage: null, results: [{ doc_id: 'A', page: 3 }] },                          // acerto na posição 1
  { expectDoc: 'C', expectPage: null, results: [{ doc_id: 'A', page: 3 }] },                          // erro
]);
assert.strictEqual(Math.round(m.hit[1]), 33); assert.strictEqual(Math.round(m.hit[3]), 67); assert.ok(Math.abs(m.mrr - 0.5) < 1e-9);

console.log('engine.test.js: OK');
