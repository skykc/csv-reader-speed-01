// Fast drop-in replacement for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Semantics mirror the reference exactly: a U+FEFF at the very start is
// dropped; a record ends at LF or CRLF and a line left with no characters is
// no record; a CR outside quotes that is not followed by LF is dropped
// (stray_cr); a field that opens with a quote runs to the next quote that is
// not doubled ("" inside it is one quote, each CRLF or lone CR inside it is
// read as LF); what follows its closing quote, up to the next comma or line
// break, is appended as it stands (quote_junk, when the field ends); a quote
// that never closes is a literal character and the text after it is read
// again as unquoted (unterminated_quote); a quote inside an unquoted field is
// a literal character; fields stay strings, never trimmed or converted.
// columns is the first record when header is true, else null; rows holds the
// records after it (every record when header is false), each padded with ""
// (short_row, with fields: its field count) or cut (long_row, with extra: the
// cut fields) to the first record's width. Each error is {code, line, row},
// in the order met; a record's short_row or long_row is recorded when it
// ends, with line the 1-based line its record starts on (every LF, CRLF and
// lone CR inside quotes counted) and row its record's index in rows (null
// for the header).
//
// Speed: the text is read once, left to right. Unquoted fields are found by
// a tight charCodeAt scan and taken as slices (no per-character string
// building); quoted fields are closed with indexOf and taken as one slice
// unless they hold escapes or line breaks, in which case only that field is
// rebuilt. No regex, no per-character function calls on the hot path.

const COMMA = 0;
const BREAK = 1;
const DONE = 2;

/**
 * Build a quoted field's value over [start, end): "" becomes one quote and
 * each CRLF or lone CR becomes LF. Returns [value, lineBreaks].
 */
function buildQuoted(text, start, end) {
  const parts = [];
  let breaks = 0;
  let s = start;
  let p = start;
  while (p < end) {
    const c = text.charCodeAt(p);
    if (c === 34) {
      // A quote here is one of a doubled pair (the closing quote is `end`).
      parts.push(text.slice(s, p));
      parts.push('"');
      p += 2;
      s = p;
    } else if (c === 13) {
      parts.push(text.slice(s, p));
      parts.push('\n');
      breaks++;
      p += text.charCodeAt(p + 1) === 10 ? 2 : 1;
      s = p;
    } else if (c === 10) {
      parts.push(text.slice(s, p));
      parts.push('\n');
      breaks++;
      p++;
      s = p;
    } else {
      p++;
    }
  }
  parts.push(text.slice(s, end));
  return [parts.join(''), breaks];
}

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    let ended = COMMA;

    while (true) {
      let value;
      let added = 0;
      let needScan = false;
      let init = null;
      let junk = false;

      if (text.charCodeAt(pos) === 34) {
        // A field that opens with a quote.
        quoted = true;
        const open = pos;
        const openLine = line;
        let scan = open + 1;
        let closeQ = -1;
        let escaped = false;
        while (true) {
          const q = text.indexOf('"', scan);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            escaped = true;
            scan = q + 2;
            continue;
          }
          closeQ = q;
          break;
        }
        if (closeQ === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          needScan = true;
          init = '"';
        } else {
          // Does the quoted span hold a line break? A newline settles it;
          // only when there is none is a lone CR looked for, since a quoted
          // field with a CR but no LF is rare.
          const n1 = text.indexOf('\n', open + 1);
          let hasNL = n1 !== -1 && n1 < closeQ;
          if (!hasNL) {
            const r1 = text.indexOf('\r', open + 1);
            hasNL = r1 !== -1 && r1 < closeQ;
          }
          if (!escaped && !hasNL) {
            value = text.slice(open + 1, closeQ);
          } else {
            const built = buildQuoted(text, open + 1, closeQ);
            value = built[0];
            line += built[1];
          }
          pos = closeQ + 1;
          if (pos >= len) {
            ended = DONE;
          } else {
            const t = text.charCodeAt(pos);
            if (t === 44) {
              pos++;
              ended = COMMA;
            } else if (t === 10) {
              pos++;
              line++;
              ended = BREAK;
            } else if (t === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line++;
              ended = BREAK;
            } else {
              // What follows the closing quote is appended as it stands.
              needScan = true;
              init = value;
              junk = true;
            }
          }
        }
      } else {
        // An unquoted field (a quote inside it is a literal character).
        quoted = false;
        needScan = true;
        init = null;
      }

      if (needScan) {
        // Read unquoted characters onto `init` up to the next comma or line
        // break; a CR not followed by LF is dropped (stray_cr). `added`
        // counts the characters kept.
        let acc = init;
        let start = pos;
        let p = pos;
        while (true) {
          while (p < len) {
            const c = text.charCodeAt(p);
            if (c === 44 || c === 10 || c === 13) break;
            p++;
          }
          if (p >= len) {
            added += p - start;
            value = acc === null ? text.slice(start, p) : acc + text.slice(start, p);
            pos = p;
            ended = DONE;
            break;
          }
          const c = text.charCodeAt(p);
          if (c === 44) {
            added += p - start;
            value = acc === null ? text.slice(start, p) : acc + text.slice(start, p);
            pos = p + 1;
            ended = COMMA;
            break;
          }
          if (c === 10) {
            added += p - start;
            value = acc === null ? text.slice(start, p) : acc + text.slice(start, p);
            pos = p + 1;
            line++;
            ended = BREAK;
            break;
          }
          if (text.charCodeAt(p + 1) === 10) {
            added += p - start;
            value = acc === null ? text.slice(start, p) : acc + text.slice(start, p);
            pos = p + 2;
            line++;
            ended = BREAK;
            break;
          }
          // A lone CR: dropped, and the field goes on after it.
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          added += p - start;
          acc = acc === null ? text.slice(start, p) : acc + text.slice(start, p);
          p += 1;
          start = p;
        }
        if (junk && added > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }

      fields.push(value);
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
