// A faster drop-in for csv-reader 1.0.0 (make.fun's own reference program).
// Written from scratch from the published policy in the kit's competition.yaml:
// it must answer exactly as csv-reader does on every input, only faster.
//
// Policy (csv-reader 1.0.0):
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it one quote,
//     and each CRLF or lone CR inside it is read as LF; what follows its closing quote, up to the next
//     comma or line break, is appended as it stands (quote_junk, when the field ends); a quote that never
//     closes is a literal character, and the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records after it (every record
//     when header is false), each padded with "" (short_row, with fields: its count) or cut (long_row, with extra:
//     the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on, row its record's index in
//     rows (null for the header), in the order met.
//
// Speed strategy (no per-character loop, no per-character string building):
//   - a record whose line holds no quote and no stray CR is split with the native String.split;
//   - every other field is read with native indexOf jumps and slice() pieces;
//   - a quoted field is scanned for its closing quote with indexOf('"'), doubled quotes folded in;
//   - CR/LF inside a quoted field is normalised with one native replace, counting line breaks as it goes;
//   - all CR positions are collected once, so a stray-CR check is an O(1) pointer step, never a rescan;
//   - field readers write their result into shared variables instead of allocating a result object per field.

/** A line break inside a quoted field: CRLF or lone CR or LF, each one LF in the value. */
const NL_IN_QUOTES = /\r\n?|\n/g;

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0; // the next character to read
  let line = 1; // the line that character is on

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The last field read: its value, how it ended, and how many characters were kept onto its start.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // The next LF at or after pos, or Infinity when there is none left: every unquoted field in one
  // line ends at the same LF, so it is found once per line, not once per field. It goes stale when
  // pos crosses a line break, and is then found again.
  let nextNl = Infinity;

  // Every CR in the text, in order; crPtr is the first of them at or after pos. Positions only move
  // forward (an unterminated quote re-reads from just after its opening quote, still ahead of every
  // position readUnquoted has reached), so the pointer only ever steps forward.
  const crs = [];
  for (let i = text.indexOf('\r'); i !== -1; i = text.indexOf('\r', i + 1)) crs.push(i);
  let crPtr = 0;

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). The result lands in fValue / fEnded / fAdded.
  function readUnquoted(init) {
    let added = 0;
    let parts = null; // kept pieces beyond `init` and the current slice
    let start = pos;
    while (pos < len) {
      while (crPtr < crs.length && crs[crPtr] < pos) crPtr += 1;
      const ci = text.indexOf(',', pos);
      if (!(nextNl >= pos)) {
        const found = text.indexOf('\n', pos);
        nextNl = found === -1 ? Infinity : found;
      }
      const ni = nextNl === Infinity ? -1 : nextNl;
      const ri = crPtr < crs.length ? crs[crPtr] : -1;
      let m = -1;
      let kind = -1;
      if (ci !== -1) {
        m = ci;
        kind = COMMA;
      }
      if (ni !== -1 && (m === -1 || ni < m)) {
        m = ni;
        kind = LINE_BREAK;
      }
      if (ri !== -1 && (m === -1 || ri < m)) {
        m = ri;
        kind = 2;
      }
      if (m === -1) break; // no delimiter left: the field runs to the end of the text
      if (kind === COMMA) {
        added += m - start;
        fValue = parts === null ? init + text.slice(start, m) : (parts.push(text.slice(start, m)), init + parts.join(''));
        fEnded = COMMA;
        fAdded = added;
        pos = m + 1;
        return;
      }
      if (kind === LINE_BREAK) {
        added += m - start;
        fValue = parts === null ? init + text.slice(start, m) : (parts.push(text.slice(start, m)), init + parts.join(''));
        fEnded = LINE_BREAK;
        fAdded = added;
        pos = m + 1;
        line += 1;
        return;
      }
      // kind === 2: a CR.
      if (text.charCodeAt(m + 1) === 10) {
        added += m - start;
        fValue = parts === null ? init + text.slice(start, m) : (parts.push(text.slice(start, m)), init + parts.join(''));
        fEnded = LINE_BREAK;
        fAdded = added;
        pos = m + 2;
        line += 1;
        return;
      }
      // A CR not followed by LF: dropped (stray_cr), the field goes on.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (parts === null) parts = [];
      parts.push(text.slice(start, m));
      added += m - start;
      pos = m + 1;
      start = pos;
    }
    added += len - start;
    fValue = parts === null ? init + text.slice(start) : (parts.push(text.slice(start)), init + parts.join(''));
    fEnded = END;
    fAdded = added;
    pos = len;
  }

  // Reads a quoted field whose opening quote is at pos. The result lands in fValue / fEnded / fAdded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    let start = pos;
    let closed = false;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) break; // no closing quote
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, the field goes on.
        value += text.slice(start, q);
        value += '"';
        pos = q + 2;
        start = pos;
        continue;
      }
      // The closing quote.
      value += text.slice(start, q);
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    // CRLF and lone CR inside the quotes are each one LF; count the line breaks the field held.
    if (value.indexOf('\r') !== -1 || value.indexOf('\n') !== -1) {
      value = value.replace(NL_IN_QUOTES, () => {
        line += 1;
        return '\n';
      });
    }
    if (pos >= len) {
      fValue = value;
      fEnded = END;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      fAdded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // Fits one record's fields to the first record's width, recording short_row / long_row, and stores it.
  function storeRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record is one line holding no quote and no stray CR (a CR just before the LF
    // ending the line is the CRLF ending, not content). The fields are the line split on commas.
    const nl = text.indexOf('\n', pos);
    nextNl = nl === -1 ? Infinity : nl;
    const segEnd = nl === -1 ? len : nl;
    const crlf = nl !== -1 && text.charCodeAt(segEnd - 1) === 13;
    const qi = text.indexOf('"', pos);
    const hasQuote = qi !== -1 && qi < segEnd;
    while (crPtr < crs.length && crs[crPtr] < pos) crPtr += 1;
    const cr = crPtr < crs.length ? crs[crPtr] : -1;
    const hasCR = cr !== -1 && cr < (crlf ? segEnd - 1 : segEnd);
    if (!hasQuote && !hasCR) {
      storeRecord(text.slice(pos, crlf ? segEnd - 1 : segEnd).split(','));
      pos = nl === -1 ? len : nl + 1;
      line += 1;
      continue;
    }

    // The record holds a quote or a stray CR: read it field by field.
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    storeRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
