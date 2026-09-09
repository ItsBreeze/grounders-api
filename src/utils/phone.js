/**
 * Phones are coerced toward E.164 so "780-901-1304" matches a stored
 * "+17809011304". North-American default; international callers send a
 * leading '+'. Returns null when there is nothing usable.
 *
 * Shared by the connector's consent page and the Offhand partner link, so one
 * person's number resolves the same way whichever door they come in by.
 */
function phoneFrom(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (!d.replace(/\D/g, '')) return null;
  if (!d.startsWith('+')) {
    if (d.length === 10) d = `+1${d}`;
    else if (d.length === 11 && d.startsWith('1')) d = `+${d}`;
    else d = `+${d}`;
  }
  const digits = d.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

module.exports = { phoneFrom };
