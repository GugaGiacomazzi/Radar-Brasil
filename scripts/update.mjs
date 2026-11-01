// Radar Brasil — robô de atualização
// Roda no GitHub Actions (Node 20+, sem dependências). Busca cotações, indicadores
// oficiais e manchetes de fontes oficiais, e grava data/data.json para a página ler.
// Cada fonte é independente: se uma falhar, o valor anterior é mantido e o erro vai
// para o log e para data.json -> errors.

import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../data/data.json', import.meta.url);
const BRAPI_TOKEN = process.env.BRAPI_TOKEN || '';
const UA = 'Mozilla/5.0 (compatible; RadarBrasil/1.0; +https://github.com)';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------------------------------------------------------------------------
// FONTES DE NOTÍCIAS — só órgãos oficiais. Para trocar ou adicionar, edite aqui.
// cat: "politica" ou "economia". Se um feed falhar, ele aparece no log da Action.
// ---------------------------------------------------------------------------
const FEEDS = [
  // urls: o robô tenta na ordem e usa o primeiro endereço que responder.
  { source: 'Agência Senado',     cat: 'politica', urls: ['https://www12.senado.leg.br/noticias/feed/ultimasnoticias/RSS', 'https://www12.senado.leg.br/noticias/rss', 'https://www12.senado.leg.br/noticias/ultimas/RSS'] },
  { source: 'Agência Câmara',     cat: 'politica', url: 'https://www.camara.leg.br/noticias/rss/ultimas-noticias' },
  { source: 'TSE',                cat: 'politica', url: 'https://www.tse.jus.br/comunicacao/noticias/RSS' },
  { source: 'Planalto (governo)', cat: 'politica', url: 'https://www.gov.br/planalto/pt-br/acompanhe-o-planalto/noticias/RSS' },
  { source: 'Gov.br · Economia (governo)', cat: 'economia', url: 'https://www.gov.br/pt-br/noticias/financas-impostos-e-gestao-publica/RSS' },
  { source: 'IBGE',               cat: 'economia', url: 'https://agenciadenoticias.ibge.gov.br/agencia-noticias.rss' },
  { source: 'Banco Central',      cat: 'economia', url: 'https://www.bcb.gov.br/api/feed/sitebcb/sitefeeds/notasImprensa' },
];
const NEWS_PER_FEED = 6;
const NEWS_TOTAL = 24;

// Impostômetro (ACSP) não tem API pública. Estes são os dois últimos marcos
// divulgados; a página extrapola em linha reta. Atualize quando sair marca nova.
const TAX = { year: 2026, marks: [ { date: '2026-03-27', value: 1e12 }, { date: '2026-09-28', value: 3e12 } ] };

// Séries do SGS (Banco Central). Se alguma mudar de número, ajuste aqui.
// debtPct = dívida bruta do governo geral (% do PIB); debtBRL = a mesma dívida em R$ milhões.
const SGS = { selic: 432, ipca12m: 13522, debtPct: 13762, debtBRL: 13761 };
const MAX_AGE_DAYS = 150; // série mensal mais velha que isso é tratada como desatualizada

// ---------------------------------------------------------------------------
const errors = [];
const log = (...a) => console.log('[radar]', ...a);

async function get(url, { json = true, headers = {} } = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': json ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*', 'Accept-Language': 'pt-BR,pt;q=0.9', ...headers }, signal: AbortSignal.timeout(20000) });
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
// Procura um campo pelo nome em qualquer nível da resposta (a brapi já mudou o formato antes).
function deep(o, names, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 5) return undefined;
  for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n];
  for (const v of Object.values(o)) { const r = deep(v, names, depth + 1); if (r !== undefined) return r; }
}
const shape = o => JSON.stringify(o).replace(/"token"\s*:\s*"[^"]*"/g, '').slice(0, 300);
async function ibov() {
  if (!BRAPI_TOKEN) throw new Error('segredo BRAPI_TOKEN não configurado');
  const h = { Authorization: 'Bearer ' + BRAPI_TOKEN };
  const enc = encodeURIComponent('^BVSP');
  const tries = [
    `https://brapi.dev/api/quote/${enc}?range=1mo&interval=1d`,
    `https://brapi.dev/api/quote/${enc}`,
    `https://brapi.dev/api/v2/stocks/quote?symbols=${enc}`,
  ];
  let j, price, last = '';
  for (const u of tries) {
    try { j = await get(u, { headers: h }); } catch (e) { last = e.message; continue; }
    price = num(deep(j, ['regularMarketPrice', 'price', 'close', 'last']));
    if (isFinite(price)) break;
    last = 'resposta sem preço: ' + shape(j);
  }
  if (!isFinite(price)) throw new Error(last);
  const pct = num(deep(j, ['regularMarketChangePercent', 'changePercent', 'change_percent']));
  const rows = deep(j, ['historicalDataPrice', 'historical', 'prices']) || [];
  const history = (Array.isArray(rows) ? rows : []).map(x => {
    const d = pick(x, 'date', 'datetime', 'timestamp');
    const t = typeof d === 'number' ? new Date(d < 1e12 ? d * 1000 : d) : new Date(d);
    return isNaN(t) ? null : { d: t.toISOString().slice(0, 10), c: num(pick(x, 'close', 'adjustedClose')) };
  }).filter(x => x && isFinite(x.c)).slice(-22);
  if (!history.length) errors.push('Ibovespa histórico: resposta sem historicalDataPrice');
  return { price, pct, time: new Date().toISOString(), history };
}

// ---- Indicadores oficiais (SGS / Banco Central) ------------------------------
async function sgs(code, n = 1) {
  let j;
  for (let i = 0; i < 2; i++) {
    j = await get(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados/ultimos/${n}?formato=json`);
    if (Array.isArray(j)) break;
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!Array.isArray(j)) throw new Error('resposta inesperada: ' + JSON.stringify(j).slice(0, 120));
  // A API nem sempre devolve em ordem cronológica: ordena do mais antigo para o mais recente.
  return j.map(x => { const [d, m, y] = x.data.split('/'); return { date: `${y}-${m}-${d}`, value: num(x.valor) }; })
          .sort((a, b) => a.date.localeCompare(b.date));
}
async function indicators(prev) {
  const ind = { ...(prev || {}) };
  // Descarta valores antigos que ficaram salvos de uma execução com série desatualizada.
  const oldDate = d => !d || (Date.now() - Date.parse(d)) / 864e5 > MAX_AGE_DAYS;
  if (ind.debt && oldDate(ind.debt.refMonth + '-01')) delete ind.debt;
  if (ind.debtPct && oldDate(ind.debtPct.date)) delete ind.debtPct;
  const s = await attempt('Selic (SGS 432)', () => sgs(SGS.selic));
  if (s) ind.selic = s.at(-1);
  const i = await attempt('IPCA 12m (SGS 13522)', () => sgs(SGS.ipca12m));
  if (i) ind.ipca12m = i.at(-1);
  const fresh = (rows, name) => {
    const age = (Date.now() - Date.parse(rows.at(-1).date)) / 864e5;
    if (age > MAX_AGE_DAYS) throw new Error(`${name}: último dado é de ${rows.at(-1).date} (desatualizado)`);
    return rows;
  };
  const p = await attempt('Dívida/PIB (SGS 13762)', async () => fresh(await sgs(SGS.debtPct), 'SGS 13762'));
  if (p) ind.debtPct = p.at(-1);
  const b = await attempt('Dívida R$ (SGS 13761)', async () => fresh(await sgs(SGS.debtBRL, 13), 'SGS 13761'));
  if (b && b.length >= 2) {
    const brl = v => v * 1e6; // série em R$ milhões
    const last = b.at(-1), first = b[0];
    const secs = (Date.parse(last.date) - Date.parse(first.date)) / 1000;
    const perSec = secs > 0 ? (brl(last.value) - brl(first.value)) / secs : 0;
    // Âncora no fim do mês de referência (o SGS data a observação no dia 1º do mês).
    const ref = new Date(last.date + 'T03:00:00Z'); ref.setUTCMonth(ref.getUTCMonth() + 1);
    ind.debt = { value: brl(last.value), refMonth: last.date.slice(0, 7), from: ref.toISOString(),
                 perSec: perSec > 0 ? perSec : (prev?.debt?.perSec || 0) };
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
  let blocks = [], lastErr = new Error('nenhum item no feed (endereço mudou?)');
  outer: for (const u of f.urls || [f.url]) {
    for (const ua of [UA, UA_BROWSER]) {
      try {
        const xml = await get(u, { json: false, headers: { 'User-Agent': ua } });
        blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
        if (blocks.length) break outer;
        lastErr = new Error('nenhum item no feed (endereço mudou?)');
      } catch (e) { lastErr = e; }
    }
  }
  if (!blocks.length) throw lastErr;
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
