/**
 * Diff riga per riga fra due testi, allineato in coppie.
 *
 * Perche' non basta mostrare "prima" e "dopo" affiancati: su una pipeline di trenta righe la
 * differenza fra due blocchi di YAML e' esattamente la cosa che l'occhio non trova. E chi accetta
 * una proposta dell'assistente senza vedere cosa cambia sta accettando alla cieca.
 *
 * Perche' scritto qui invece di aggiungere una libreria: serve un allineamento di righe, non un
 * diff di parole, ed e' una LCS di trenta righe. Una dipendenza in piu' nel pacchetto incorporabile
 * costa piu' di quanto valga.
 *
 * Le coppie restituite hanno sempre la stessa lunghezza da entrambi i lati:
 *   - `left === null`  → riga solo nel testo nuovo (aggiunta)
 *   - `right === null` → riga solo nel vecchio (rimossa)
 *   - `changed`        → la riga esiste da entrambi i lati ma nella stessa posizione differisce
 */
export interface DiffLine {
  left: string | null;
  right: string | null;
  changed: boolean;
}

/** Soglia oltre la quale si rinuncia alla LCS: O(n·m) su testi enormi bloccherebbe il rendering. */
const MAX_LCS_LINES = 800;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = (before || '').replace(/\s+$/, '').split('\n');
  const b = (after || '').replace(/\s+$/, '').split('\n');
  if (a.length === 1 && a[0] === '') return b.map((r) => ({ left: null, right: r, changed: false }));
  if (b.length === 1 && b[0] === '') return a.map((l) => ({ left: l, right: null, changed: false }));

  // Ripiego per testi molto grandi: affiancamento posizionale. Meno preciso ma immediato, e su
  // quelle dimensioni nessuno legge il diff riga per riga.
  if (a.length * b.length > MAX_LCS_LINES * MAX_LCS_LINES) {
    const n = Math.max(a.length, b.length);
    const out: DiffLine[] = [];
    for (let i = 0; i < n; i++) {
      const l = i < a.length ? a[i] : null;
      const r = i < b.length ? b[i] : null;
      out.push({ left: l, right: r, changed: l !== null && r !== null && l !== r });
    }
    return out;
  }

  // LCS classica sulle righe.
  const m = a.length, n = b.length;
  const len: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ left: a[i], right: b[j], changed: false });
      i++; j++;
    } else if (len[i + 1][j] >= len[i][j + 1]) {
      // Riga rimossa. Se la prossima operazione e' un'aggiunta, le si accoppia: una riga
      // MODIFICATA si legge molto meglio di una rimozione seguita da un'inserimento.
      if (len[i][j + 1] === len[i + 1][j] && j < n) {
        out.push({ left: a[i], right: b[j], changed: true });
        i++; j++;
      } else {
        out.push({ left: a[i], right: null, changed: false });
        i++;
      }
    } else {
      out.push({ left: null, right: b[j], changed: false });
      j++;
    }
  }
  while (i < m) { out.push({ left: a[i++], right: null, changed: false }); }
  while (j < n) { out.push({ left: null, right: b[j++], changed: false }); }
  return out;
}
