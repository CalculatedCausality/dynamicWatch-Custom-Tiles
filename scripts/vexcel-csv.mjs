// A small CSV reader for address,lat,lon rows. Supports RFC-style quoted
// commas, embedded newlines and doubled quotes; rejects incomplete rows.
export function parseAddressCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, ended = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; ended = true; }
      else field += ch;
    } else if (ch === '"' && !field && !ended) quoted = true;
    else if (ch === ',') { row.push(field); field = ''; ended = false; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; ended = false;
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else if (ended && !/\s/.test(ch)) throw new Error('Invalid CSV quoting');
    else if (!ended) field += ch;
  }
  if (quoted) throw new Error('Unterminated CSV quoted field');
  if (field || row.length) { row.push(field); if (row.some((cell) => cell.trim())) rows.push(row); }
  if (rows.length < 2) throw new Error('CSV needs a header and at least one address');
  const header = rows.shift().map((name) => name.replace(/^\ufeff/, '').trim().toLowerCase());
  const addressCol = header.indexOf('address'), latCol = header.indexOf('lat'), lonCol = header.indexOf('lon');
  if (addressCol < 0) throw new Error('CSV needs an address column');
  if ((latCol < 0) !== (lonCol < 0)) throw new Error('CSV needs both lat and lon columns');
  if (rows.length > 200) throw new Error('CSV is limited to 200 addresses per batch');
  return rows.map((fields, index) => {
    if (fields.length !== header.length || !fields[addressCol]?.trim()) {
      throw new Error(`Invalid CSV address row ${index + 2}`);
    }
    const lat = latCol < 0 ? '' : fields[latCol].trim();
    const lon = lonCol < 0 ? '' : fields[lonCol].trim();
    if (!!lat !== !!lon) throw new Error(`CSV row ${index + 2} needs both lat and lon`);
    return { address: fields[addressCol].trim(), coordinates: lat ? { lat, lon } : undefined };
  });
}
