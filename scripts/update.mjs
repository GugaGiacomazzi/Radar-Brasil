// Radar Brasil — robô de atualização
// Roda no GitHub Actions (Node 20+, sem dependências). Busca cotações, indicadores
// oficiais e manchetes de fontes oficiais, e grava data/data.json para a página ler.
// Cada fonte é independente: se uma falhar, o valor anterior é mantido e o erro vai
// para o log e para data.json -> errors.

import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../data/data.json', import.meta.url);
const BRAPI_TOKEN = process.env.BRAPI_TOKEN || '';
const UA = 'Mozilla/5.0 (RadarBrasil; +https://github.com)';

// ---------------------------------------------------------------------------
// FONTES DE NOTÍCIAS — só órgãos oficiais. Para trocar ou adicionar, edite aqui.
// cat: "politica" ou "economia". Se um feed falhar, ele aparece no log da Action.
// ---------------------------------------------------------------------------
const FEEDS = [
  { source: 'Agência Senado',     cat: 'politica', url: 'https://www12.senado.leg.br/noticias/feed/todasasnoticias/RSS' },
  { source: 'Agência Câmara',     cat: 'politica', url: 'https://www.camara.leg.br/noticias/rss/ultimas-noticias' },
  { source: 'TSE',                cat: 'politica', url: 'https://www.tse.jus.br/comunicacao/noticias/RSS' },
  { source: 'Planalto (governo)', cat: 'politica', url: 'https://www.gov.br/planalto/pt-br/acompanhe-o-planalto/noticias/RSS' },
  { source: 'Ministério da Fazenda (governo)', cat: 'economia', url: 'https://www.gov.br/fazenda/pt-br/assuntos/noticias/RSS' },
  { source: 'IBGE',               cat: 'economia', url: 'https://agenciadenoticias.ibge.gov.br/agencia-noticias.rss' },
  { source: 'Banco Central',      cat: 'economia', url: 'https://www.bcb.gov.br/api/feed/sitebcb/sitefeeds/notasImprensa' },
];
const NEWS_PER_FEED = 6;
const NEWS_TOTAL = 24;

// Impostômetro (ACSP) não tem API pública. Estes são os dois últimos marcos
// divulgados; a página extrapola em linha reta. Atualize quando sair marca nova.
const TAX = { year: 2026, marks: [ { date: '2026-03-27', value: 1e12 }, { date: '2026-09-28', value: 3e12 } ] };

// Séries do SGS (Banco Central). Se alguma mudar de número, ajuste aqui.
const SGS = { selic: 432, ipca12m: 13522, debtBRL: 13761, debtPct: 13762 };

// ---------------------------------------------------------------------------
const errors = [];
const log = (...a) => console.log('[radar]', ...a);

async function get(url, { json = true, headers = {} } = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return json ? r.json() : r.text();
}
async function attempt(name, fn) {
  try { const v = await fn(); log('ok', name); return v; }
  catch (e) { const msg = `${name}: ${e.message}`; errors.push(msg); log('FALHOU', msg); return undefined; }
}
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(String(v).replace(',', '.')));
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; };

// ---- Câmbio (AwesomeAPI) ---------------------------------------------------
async function fx() {
  const j = await get('https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL,GBP-BRL');
  const out = {};
  for (const c of ['USD', 'EUR', 'GBP']) {
    const q = j[c + 'BRL'];
    if (!q) throw new Error('par ' + c + ' ausente');
    out[c] = { bid: num(q.bid), pct: num(q.pctChange), time: q.create_date };
  }
  return out;
}

// ---- Ibovespa (brapi) --------------------------------------------------------
async function ibov() {
  if (!BRAPI_TOKEN) throw new Error('segredo BRAPI_TOKEN não configurado');
  const h = { Authorization: 'Bearer ' + BRAPI_TOKEN };
  const enc = encodeURIComponent('^BVSP');
  let quote;
  try { quote = await get(`https://brapi.dev/api/v2/stocks/quote?symbols=${enc}`, { headers: h }); }
  catch { quote = await get(`https://brapi.dev/api/quote/${enc}?token=${BRAPI_TOKEN}`); }
  const r = (pick(quote, 'results', 'data', 'stocks') || [])[0] || {};
  const price = num(pick(r, 'regularMarketPrice', 'price', 'close'));
  const pct = num(pick(r, 'regularMarketChangePercent', 'changePercent', 'change_percent'));
  if (!isFinite(price)) throw new Error('preço não encontrado na resposta');

  let history = [];
  await attempt('ibovespa histórico', async () => {
    let hj;
    try { hj = await get(`https://brapi.dev/api/v2/stocks/historical?symbols=${enc}&range=1mo&interval=1d`, { headers: h }); }
    catch { hj = await get(`https://brapi.dev/api/quote/${enc}?range=1mo&interval=1d&token=${BRAPI_TOKEN}`); }
    const hr = (pick(hj, 'results', 'data') || [])[0] || {};
    const rows = pick(hr, 'historicalDataPrice', 'historical', 'prices') || [];
    history = rows.map(x => {
      const d = pick(x, 'date', 'datetime', 'timestamp');
      const t = typeof d === 'number' ? new Date(d < 1e12 ? d * 1000 : d) : new Date(d);
      return { d: t.toISOString().slice(0, 10), c: num(pick(x, 'close', 'adjustedClose')) };
    }).filter(x => isFinite(x.c)).slice(-22);
    if (!history.length) throw new Error('sem pontos');
  });
  return { price, pct, time: new Date().toISOString(), history };
}

// ---- Indicadores oficiais (SGS / Banco Central) ------------------------------
async function sgs(code, n = 1) {
  const j = await get(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados/ultimos/${n}?formato=json`);
  return j.map(x => { const [d, m, y] = x.data.split('/'); return { date: `${y}-${m}-${d}`, value: num(x.valor) }; });
}
async function indicators(prev) {
  const ind = { ...(prev || {}) };
  const s = await attempt('Selic (SGS 432)', () => sgs(SGS.selic));
  if (s) ind.selic = s.at(-1);
  const i = await attempt('IPCA 12m (SGS 13522)', () => sgs(SGS.ipca12m));
  if (i) ind.ipca12m = i.at(-1);
  const p = await attempt('Dívida/PIB (SGS 13762)', () => sgs(SGS.debtPct));
  if (p) ind.debtPct = p.at(-1);
  const b = await attempt('Dívida R$ (SGS 13761)', () => sgs(SGS.debtBRL, 13));
  if (b && b.length >= 2) {
    const scale = v => (v < 1e9 ? v * 1e6 : v); // série vem em R$ milhões
    const last = b.at(-1), first = b[0];
    const secs = (Date.parse(last.date) - Date.parse(first.date)) / 1000;
    // Âncora no fim do mês de referência (o SGS data a observação no dia 1º do mês).
    const ref = new Date(last.date + 'T03:00:00Z'); ref.setUTCMonth(ref.getUTCMonth() + 1);
    ind.debt = { value: scale(last.value), refMonth: last.date.slice(0, 7), from: ref.toISOString(),
                 perSec: secs > 0 ? (scale(last.value) - scale(first.value)) / secs : 0 };
  }
  return ind;
}

// ---- Notícias (RSS/Atom) -------------------------------------------------------
const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, '') // tags que vinham escapadas (&lt;p&gt;)
  .replace(/\s+/g, ' ').trim();
const tag = (block, names) => {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return decode(m[1]);
  }
  if (names.includes('link')) { const m = block.match(/<link[^>]*href="([^"]+)"/i); if (m) return m[1]; }
  return '';
};
async function feed(f) {
  const xml = await get(f.url, { json: false });
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  if (!blocks.length) throw new Error('nenhum item no feed (endereço mudou?)');
  return blocks.slice(0, NEWS_PER_FEED).map(b => {
    const d = tag(b, ['pubDate', 'dc:date', 'updated', 'published']);
    const t = Date.parse(d);
    return { title: tag(b, ['title']), link: tag(b, ['link', 'guid']), date: isFinite(t) ? new Date(t).toISOString() : null,
             summary: tag(b, ['description', 'summary']).slice(0, 260), source: f.source, cat: f.cat };
  }).filter(n => n.title && n.link);
}

// ---------------------------------------------------------------------------
const prev = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => ({}));

const fxData = await attempt('câmbio (AwesomeAPI)', fx);
const ibData = await attempt('Ibovespa (brapi)', ibov);
const indData = await indicators(prev.indicators);

const lists = await Promise.all(FEEDS.map(f => attempt('feed ' + f.source, () => feed(f))));
let news = lists.flat().filter(Boolean);
const seen = new Set();
news = news.filter(n => !seen.has(n.link) && seen.add(n.link))
  .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  .slice(0, NEWS_TOTAL);

const ibovOut = ibData ? { ...ibData, history: ibData.history.length ? ibData.history : (prev.market?.ibov?.history || []) } : prev.market?.ibov;

const data = {
  updated: new Date().toISOString(),
  market: { ibov: ibovOut, fx: fxData || prev.market?.fx },
  indicators: indData,
  tax: TAX,
  news: news.length ? news : (prev.news || []),
  errors,
};
await writeFile(OUT, JSON.stringify(data, null, 2) + '\n');
log(`pronto: ${data.news.length} notícias, ${errors.length} erro(s)`);
