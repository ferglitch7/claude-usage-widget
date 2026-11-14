// Number, money and date formatting. Everything is priced in USD internally and
// converted to the display currency at render time.

const LOCALE = (typeof navigator !== 'undefined' && navigator.language) || 'es';

export const CURRENCIES = {
  USD: { name: 'Dólar', flag: 'us' },
  EUR: { name: 'Euro', flag: 'european_union' },
  MXN: { name: 'Peso mexicano', flag: 'mx' },
  GBP: { name: 'Libra esterlina', flag: 'gb' },
  CAD: { name: 'Dólar canadiense', flag: 'ca' },
  CHF: { name: 'Franco suizo', flag: 'ch' },
  JPY: { name: 'Yen japonés', flag: 'jp' },
  AUD: { name: 'Dólar australiano', flag: 'au' },
  BRL: { name: 'Real brasileño', flag: 'br' },
  ARS: { name: 'Peso argentino', flag: 'ar' },
  COP: { name: 'Peso colombiano', flag: 'co' },
  CLP: { name: 'Peso chileno', flag: 'cl' },
  PEN: { name: 'Sol peruano', flag: 'pe' },
  UYU: { name: 'Peso uruguayo', flag: 'uy' },
  DOP: { name: 'Peso dominicano', flag: 'do' },
  CRC: { name: 'Colón costarricense', flag: 'cr' },
  GTQ: { name: 'Quetzal guatemalteco', flag: 'gt' },
  CNY: { name: 'Yuan chino', flag: 'cn' },
  HKD: { name: 'Dólar de Hong Kong', flag: 'hk' },
  SGD: { name: 'Dólar de Singapur', flag: 'sg' },
  INR: { name: 'Rupia india', flag: 'in' },
  KRW: { name: 'Won surcoreano', flag: 'kr' },
  SEK: { name: 'Corona sueca', flag: 'se' },
  NOK: { name: 'Corona noruega', flag: 'no' },
  DKK: { name: 'Corona danesa', flag: 'dk' },
  PLN: { name: 'Esloti polaco', flag: 'pl' },
  TRY: { name: 'Lira turca', flag: 'tr' },
  ZAR: { name: 'Rand sudafricano', flag: 'za' },
  AED: { name: 'Dírham de los EAU', flag: 'ae' },
  NZD: { name: 'Dólar neozelandés', flag: 'nz' },
};

const cache = new Map();
function nf(key, opts) {
  let f = cache.get(key);
  if (!f) { f = new Intl.NumberFormat(LOCALE, opts); cache.set(key, f); }
  return f;
}

function moneyFormat(ccy, digits) {
  return nf(`m:${ccy}:${digits}`, {
    style: 'currency', currency: ccy, currencyDisplay: 'narrowSymbol', useGrouping: 'always',
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

// Fraction digits a currency normally uses (JPY, CLP, KRW... have none).
function baseDigits(ccy) {
  return nf(`d:${ccy}`, { style: 'currency', currency: ccy }).resolvedOptions().maximumFractionDigits;
}

/** A holding's value: always the currency's normal precision. */
export function money(v, ccy) {
  if (!Number.isFinite(v)) return '—';
  return moneyFormat(ccy, baseDigits(ccy)).format(v);
}

/** Same as money() but split so the fraction can be styled smaller. */
export function moneyParts(v, ccy) {
  if (!Number.isFinite(v)) return [{ type: 'integer', value: '—' }];
  return moneyFormat(ccy, baseDigits(ccy)).formatToParts(v);
}

/** A unit price: small prices need more decimals than a currency normally shows. */
export function price(v, ccy) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  let d = baseDigits(ccy);
  if (a > 0 && a < 1) d = Math.min(8, Math.max(d, 2 - Math.floor(Math.log10(a)) + 1));
  else if (a < 10) d = Math.max(d, Math.min(d + 1, 3));
  return moneyFormat(ccy, d).format(v);
}

/** Large amounts in short form: $1.37 B. */
export function compactMoney(v, ccy) {
  if (!Number.isFinite(v)) return '—';
  return nf(`c:${ccy}`, { style: 'currency', currency: ccy, currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 2 }).format(v);
}

/**
 * The balance counted in units of an asset instead of money: ₿0.7443 or
 * 13.02 oz of gold. Same part types as moneyParts(), for the rolling number.
 */
export function unitParts(v, unit) {
  if (!Number.isFinite(v)) return [{ type: 'integer', value: '—' }];
  if (unit === 'btc') {
    const d = v >= 100 ? 2 : v >= 1 ? 4 : 5;
    return [{ type: 'currency', value: '₿' }, ...nf(`u:${d}`, { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' }).formatToParts(v)];
  }
  const d = v >= 1000 ? 0 : v >= 100 ? 1 : 2;
  return [...nf(`u:${d}`, { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' }).formatToParts(v), { type: 'literal', value: ' oz' }];
}

export function unitText(v, unit) {
  return unitParts(v, unit).map(p => p.value).join('');
}

export function signedMoney(v, ccy) {
  if (!Number.isFinite(v)) return '—';
  const s = money(Math.abs(v), ccy);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + s;
}

export function pct(ratio, { sign = true } = {}) {
  if (!Number.isFinite(ratio)) return '—';
  const s = nf('pct', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(ratio));
  if (!sign) return s;
  return (ratio > 0 ? '+' : ratio < 0 ? '−' : '') + s;
}

export function share(ratio) {
  if (!Number.isFinite(ratio)) return '—';
  return nf('share', { style: 'percent', maximumFractionDigits: ratio < 0.1 ? 1 : 0 }).format(ratio);
}

export function qty(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : 8;
  return nf(`q:${d}`, { maximumFractionDigits: d, useGrouping: 'always' }).format(v);
}

function separators(locale) {
  const parts = new Intl.NumberFormat(locale, { useGrouping: true, minimumFractionDigits: 1 }).formatToParts(11111.5);
  const dec = (parts.find(p => p.type === 'decimal') || {}).value || '.';
  return { dec, grp: dec === ',' ? '.' : ',' };
}

/**
 * Parse what a person types. With both marks present the last one is the
 * decimal ("1,234.5", "1.234,5"). With only one, the locale decides: its
 * grouping mark counts as grouping only when the digits are grouped in threes
 * ("52,000"), otherwise it is taken as a decimal ("0,5").
 */
export function parseNumber(str, locale = LOCALE) {
  if (typeof str !== 'string') return NaN;
  let s = str.trim().replace(/[\s\u00a0\u202f']/g, '');
  if (!s || !/^\d*(?:[.,]\d*)*$/.test(s) || !/\d/.test(s)) return NaN;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    const dec = lastComma > lastDot ? ',' : '.';
    const grp = dec === ',' ? '.' : ',';
    const [whole, ...rest] = s.split(dec);
    // The grouping mark must really group in threes, and the decimal appear once.
    if (rest.length > 1 || !new RegExp('^\\d{1,3}(?:\\' + grp + '\\d{3})+$').test(whole)) return NaN;
    s = whole.split(grp).join('') + '.' + rest[0];
  } else if (lastComma > -1 || lastDot > -1) {
    const mark = lastComma > -1 ? ',' : '.';
    const { grp } = separators(locale);
    const grouped = new RegExp('^\\d{1,3}(?:\\' + mark + '\\d{3})+$').test(s);
    const count = s.split(mark).length - 1;
    if ((mark === grp && grouped) || count > 1) s = s.split(mark).join('');
    else s = s.replace(mark, '.');
  }
  if (s.split('.').length > 2) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** A plain editable string for a number (no grouping), in the user's decimal mark. */
export function editable(v) {
  if (!Number.isFinite(v)) return '';
  const s = String(Number(v.toFixed(8)));
  const dec = nf('dec', { minimumFractionDigits: 1 }).format(1.1).replace(/\d/g, '');
  return s.includes('e') ? v.toFixed(8).replace(/0+$/, '').replace('.', dec) : s.replace('.', dec);
}

export function dateLabel(ts) {
  return new Date(ts).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
}

/** "hace 3 min", "hace 2 h", or a date for anything older than a day. */
export function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60e3);
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m} min`;
  if (m < 24 * 60) return `hace ${Math.round(m / 60)} h`;
  return dateLabel(ts);
}

export function timeLabel(ts, range) {
  const d = new Date(ts);
  if (range === '1D') return d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  if (range === '1S') return d.toLocaleString(LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: range === '1A' ? 'numeric' : undefined });
}
