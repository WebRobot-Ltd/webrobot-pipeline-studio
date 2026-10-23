/**
 * Identita' visiva degli stage: famiglia, icona, colore e una riga che dice cosa fanno.
 *
 * Perche' per FAMIGLIA e non stage per stage: il catalogo e' vivo e oggi conta 111 stage, con
 * plugin che ne aggiungono altri. Una tabella nome-per-nome sarebbe incompleta il giorno dopo.
 *
 * Perche' non ci si puo' fidare della sola `category` del catalogo: misurata sul catalogo reale
 * (2026-09-25) e' incoerente e incompleta —
 *   - 26 stage su 111 non hanno categoria, e sono TUTTI connettori a fonti esterne
 *     (bancaItalia, coinGecko, eurostat, fred, worldBank, openMeteo, stockPrice…);
 *   - convivono `extraction` ed `Extract`, `io` e `Data Sink`, piu' una `Sports Betting` isolata.
 * Quindi: prima si normalizza la categoria, poi si ripiega sul NOME dello stage, e solo alla
 * fine su una famiglia neutra. Cosi' uno stage nuovo ottiene comunque un colore sensato invece
 * di restare grigio.
 */

export type StageFamily =
  | 'acquire' | 'source' | 'extract' | 'intelligent'
  | 'transform' | 'knowledge' | 'output' | 'usecase' | 'other';

export interface FamilyLook {
  /** Etichetta breve mostrata accanto allo stage. */
  label: string;
  icon: string;
  /** Classi Tailwind: bordo sinistro colorato, pastiglia, testo. */
  bar: string;
  chip: string;
  /** Riquadro dietro l'icona: fondo + anello della famiglia, perche' l'emoji si legga a colpo d'occhio. */
  tile: string;
  /** Una riga che spiega a cosa serve la famiglia, per chi non conosce il vocabolario. */
  blurb: string;
  /** Fase della pipeline a cui appartiene, per la guida alla sequenza. */
  phase: 1 | 2 | 3 | 4 | null;
}

export const FAMILIES: Record<StageFamily, FamilyLook> = {
  acquire: {
    label: 'Acquire', icon: '🌐', phase: 1,
    bar: 'border-l-blue-500', chip: 'bg-slate-50 text-slate-700 border-slate-200', tile: 'bg-slate-100 ring-slate-200',
    blurb: 'Opens web pages and brings them into the pipeline.',
  },
  source: {
    label: 'Source', icon: '🔌', phase: 1,
    bar: 'border-l-cyan-500', chip: 'bg-slate-50 text-slate-700 border-slate-200', tile: 'bg-slate-100 ring-slate-200',
    blurb: 'Pulls data from a service or public dataset, without browsing.',
  },
  extract: {
    label: 'Extract', icon: '🎯', phase: 2,
    bar: 'border-l-amber-500', chip: 'bg-slate-50 text-slate-700 border-slate-200', tile: 'bg-slate-100 ring-slate-200',
    blurb: 'Picks the fields to keep out of a page.',
  },
  intelligent: {
    label: 'AI-assisted', icon: '🧠', phase: 2,
    bar: 'border-l-violet-500', chip: 'bg-slate-50 text-slate-700 border-slate-200', tile: 'bg-slate-100 ring-slate-200',
    blurb: 'Same job, but by understanding the page — no hand-written selectors.',
  },
  transform: {
    label: 'Transform', icon: '⚙️', phase: 3,
    bar: 'border-l-slate-500', chip: 'bg-slate-50 text-slate-700 border-slate-200', tile: 'bg-slate-100 ring-slate-200',
    blurb: 'Cleans, joins, de-duplicates, computes.',
  },
  knowledge: {
    label: 'Knowledge', icon: '📚', phase: 3,
    bar: 'border-l-indigo-500', chip: 'bg-slate-50 text-slate-700 border-slate-200', tile: 'bg-slate-100 ring-slate-200',
    blurb: 'Indexes text so it can be queried later.',
  },
  output: {
    label: 'Destination', icon: '💾', phase: 4,
    bar: 'border-l-emerald-500', chip: 'bg-slate-50 text-slate-700 border-slate-200', tile: 'bg-slate-100 ring-slate-200',
    blurb: 'Writes the result where you need it.',
  },
  usecase: {
    label: 'Use case', icon: '🧩', phase: null,
    bar: 'border-l-pink-500', chip: 'bg-slate-50 text-slate-700 border-slate-200', tile: 'bg-slate-100 ring-slate-200',
    blurb: 'A ready-made block for a specific domain.',
  },
  other: {
    label: 'Other', icon: '▫️', phase: null,
    bar: 'border-l-slate-300', chip: 'bg-slate-50 text-slate-700 border-slate-200', tile: 'bg-slate-100 ring-slate-200',
    blurb: '',
  },
};

/** Categorie del catalogo → famiglia. Le chiavi sono normalizzate (minuscole, senza spazi). */
const BY_CATEGORY: Record<string, StageFamily> = {
  crawling: 'acquire',
  extraction: 'extract', extract: 'extract',
  intelligent: 'intelligent',
  analytics: 'transform', matching: 'transform', python: 'transform', utility: 'transform',
  rag: 'knowledge',
  io: 'output', datasink: 'output',
  externalapi: 'source',
  usecase: 'usecase', sportsbetting: 'usecase',
};

/**
 * Ripiego sul nome. Serve ai 26 stage senza categoria e a qualunque plugin futuro che non ne
 * dichiari una: meglio un colore dedotto che un grigio indistinto su un quarto del catalogo.
 */
const BY_NAME: [RegExp, StageFamily][] = [
  [/^(fetch|wget|visit|explore|crawl|autoscroll|join)/i, 'acquire'],
  [/^intelligent|^iextract/i, 'intelligent'],
  [/^(extract|flatselect|select)/i, 'extract'],
  [/^(load|save|write|sink|export|publish)/i, 'output'],
  [/^(rag|index|embed)/i, 'knowledge'],
  [/(dedup|dedupe|merge|filter|map|aggregate|group|sort|python|transform|clean|normal)/i, 'transform'],
  // Connettori a servizi esterni: nel catalogo reale sono l'intero gruppo senza categoria.
  [/(api|source|price|geocode|weather|meteo|census|registry|bank|gdp|stat|fred|oecd|llama|coin|binance|stock)/i, 'source'],
];

export function familyOf(stageName: string, category?: string | null): StageFamily {
  const norm = (category || '').toLowerCase().replace(/[^a-z]/g, '');
  if (norm && BY_CATEGORY[norm]) return BY_CATEGORY[norm];
  for (const [re, fam] of BY_NAME) if (re.test(stageName)) return fam;
  return 'other';
}

export const lookOf = (stageName: string, category?: string | null): FamilyLook =>
  FAMILIES[familyOf(stageName, category)];

/** Le quattro fasi, nell'ordine in cui una pipeline le attraversa. */
export const PHASES: { n: 1 | 2 | 3 | 4; title: string; icon: string; hint: string }[] = [
  { n: 1, title: 'Take', icon: '🌐', hint: 'Where the data comes from: a web page or an external service.' },
  { n: 2, title: 'Extract', icon: '🎯', hint: 'Which fields to keep out of what you took.' },
  { n: 3, title: 'Transform', icon: '⚙️', hint: 'Clean, join, compute. Optional.' },
  { n: 4, title: 'Save', icon: '💾', hint: 'Where the result ends up.' },
];

/**
 * Guida alla sequenza: quali fasi la pipeline copre gia' e cosa manca.
 * Non impone un ordine — una pipeline valida puo' saltare la trasformazione — ma dice a voce
 * alta cosa serve perche' produca qualcosa, che e' l'inciampo di chi progetta la prima volta.
 */
export function sequenceAdvice(
  rows: { stage: string }[],
  categoryOf: (stage: string) => string | undefined,
): { covered: Set<number>; missing: string | null } {
  const covered = new Set<number>();
  for (const r of rows) {
    const p = lookOf(r.stage, categoryOf(r.stage)).phase;
    if (p) covered.add(p);
  }
  let missing: string | null = null;
  if (rows.length === 0) missing = 'Start with a stage that takes the data: a web page or an external source.';
  else if (!covered.has(1)) missing = 'No starting point: nothing here takes any data.';
  else if (!covered.has(2) && !covered.has(3)) missing = 'You have raw data but extract nothing: add an extraction stage.';
  else if (!covered.has(4)) missing = 'The result is never saved anywhere: add a destination.';
  return { covered, missing };
}

/**
 * Human name of a stage (user 10-23: "load_csv is very technical"). The technical name stays visible
 * next to it — it is what the YAML says — but the first thing read is what the stage DOES.
 * Hand-written for the common stages; any other one (plugins included) is derived from its name, so a
 * new stage still reads as words instead of an identifier.
 */
const FRIENDLY: Record<string, string> = {
  fetch: 'Open a web page', wget: 'Open a web page', visit: 'Open a web page in a browser',
  resilientFetch: 'Open a web page (browser if needed)', fetch_resilient: 'Open a web page (browser if needed)',
  resilientJoin: "Open each item's page", wgetJoin: "Open each item's page", visitJoin: "Open each item's page in a browser",
  join: "Open each item's page", intelligentJoin: "Find and open each item's page", intelligentWgetJoin: "Find and open each item's page",
  wgetExplore: 'Follow the next pages', visitExplore: 'Follow the next pages in a browser', resilientExplore: 'Follow the next pages',
  explore: 'Follow the next pages', intelligentExplore: 'Find and follow the next pages', intelligentWgetExplore: 'Find and follow the next pages',
  flatSelect: 'Extract the items of a list', extract: 'Extract fields from the page', iextract: 'Extract fields by description',
  oddsSelect: 'Extract betting odds', odds_select: 'Extract betting odds',
  load_csv: 'Load a CSV file', load_json: 'Load a JSON file', load_parquet: 'Load a Parquet file', load_excel: 'Load an Excel file',
  load_sitemap: 'Read a sitemap', load_rss: 'Read an RSS feed', rss: 'Read an RSS feed',
  save_csv: 'Save as CSV', save_json: 'Save as JSON', save_parquet: 'Save as Parquet',
  sql_query: 'Transform with SQL', dedup: 'Remove duplicates', filter: 'Keep only matching rows', union: 'Merge the rows',
  sentiment: 'Score the sentiment', sentimentAnalysis: 'Score the sentiment', summarize: 'Summarise the text',
  translate: 'Translate the text', classify: 'Classify the rows', embed: 'Compute embeddings',
  rag_index: 'Add to the knowledge base', httpSource: 'Call a web API',
  socialAPI: 'Read a social / financial API', eurostatAPI: 'Eurostat statistics', istatAPI: 'ISTAT statistics',
};
const ACRONYMS = new Set(['csv', 'json', 'xml', 'sql', 'api', 'url', 'rss', 'pdf', 'html', 'llm', 'ai', 'ocr', 'eu', 'it', 'ean', 'id', 'rag', 'http']);
export function friendlyName(stage: string): string {
  if (!stage) return '';
  if (FRIENDLY[stage]) return FRIENDLY[stage];
  const py = /^python_[a-z_]+:(.+)$/.exec(stage);
  if (py) return `Python: ${friendlyName(py[1])}`;
  const words = stage
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-:.]+/g, ' ')
    .trim().split(/\s+/).map((w) => w.toLowerCase());
  if (!words.length) return stage;
  const out = words.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w));
  out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1);
  return out.join(' ');
}
