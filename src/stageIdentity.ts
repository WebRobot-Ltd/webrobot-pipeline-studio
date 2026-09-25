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
  /** Una riga che spiega a cosa serve la famiglia, per chi non conosce il vocabolario. */
  blurb: string;
  /** Fase della pipeline a cui appartiene, per la guida alla sequenza. */
  phase: 1 | 2 | 3 | 4 | null;
}

export const FAMILIES: Record<StageFamily, FamilyLook> = {
  acquire: {
    label: 'Acquisizione', icon: '🌐', phase: 1,
    bar: 'border-l-blue-500', chip: 'bg-blue-50 text-blue-700 border-blue-200',
    blurb: 'Apre pagine web e le porta dentro la pipeline.',
  },
  source: {
    label: 'Fonte esterna', icon: '🔌', phase: 1,
    bar: 'border-l-cyan-500', chip: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    blurb: 'Prende dati da un servizio o da un archivio pubblico, senza navigare.',
  },
  extract: {
    label: 'Estrazione', icon: '🎯', phase: 2,
    bar: 'border-l-amber-500', chip: 'bg-amber-50 text-amber-700 border-amber-200',
    blurb: 'Sceglie i campi da tenere dentro una pagina.',
  },
  intelligent: {
    label: 'Assistito da AI', icon: '🧠', phase: 2,
    bar: 'border-l-violet-500', chip: 'bg-violet-50 text-violet-700 border-violet-200',
    blurb: 'Fa lo stesso lavoro capendo la pagina, senza selettori scritti a mano.',
  },
  transform: {
    label: 'Trasformazione', icon: '⚙️', phase: 3,
    bar: 'border-l-slate-500', chip: 'bg-slate-100 text-slate-700 border-slate-300',
    blurb: 'Pulisce, unisce, toglie i doppioni, calcola.',
  },
  knowledge: {
    label: 'Conoscenza', icon: '📚', phase: 3,
    bar: 'border-l-indigo-500', chip: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    blurb: 'Indicizza i testi per poterli interrogare.',
  },
  output: {
    label: 'Destinazione', icon: '💾', phase: 4,
    bar: 'border-l-emerald-500', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    blurb: 'Scrive il risultato dove ti serve.',
  },
  usecase: {
    label: 'Caso d’uso', icon: '🧩', phase: null,
    bar: 'border-l-pink-500', chip: 'bg-pink-50 text-pink-700 border-pink-200',
    blurb: 'Blocco già pronto per un dominio specifico.',
  },
  other: {
    label: 'Altro', icon: '▫️', phase: null,
    bar: 'border-l-slate-300', chip: 'bg-slate-50 text-slate-600 border-slate-200',
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
export const PHASES: { n: 1 | 2 | 3 | 4; title: string; hint: string }[] = [
  { n: 1, title: 'Prendi', hint: 'Da dove arrivano i dati: una pagina web o un servizio esterno.' },
  { n: 2, title: 'Estrai', hint: 'Quali campi tenere di ciò che hai preso.' },
  { n: 3, title: 'Trasforma', hint: 'Pulisci, unisci, calcola. Facoltativo.' },
  { n: 4, title: 'Salva', hint: 'Dove finisce il risultato.' },
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
  if (rows.length === 0) missing = 'Comincia da uno stage che prende i dati: una pagina web o una fonte esterna.';
  else if (!covered.has(1)) missing = 'Manca il punto di partenza: nessuno stage prende i dati.';
  else if (!covered.has(2) && !covered.has(3)) missing = 'Hai i dati grezzi ma non estrai nulla: aggiungi uno stage di estrazione.';
  else if (!covered.has(4)) missing = 'Il risultato non viene salvato da nessuna parte: aggiungi una destinazione.';
  return { covered, missing };
}
