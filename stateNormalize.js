// Properties can get their `state` value from two very different sources:
// the landlord form (a <select> whose value is always a 2-letter code, e.g.
// "NJ") and the geocoder used for community-submitted addresses, which
// returns full state names from OpenStreetMap ("New Jersey") or abbreviations
// from Google ("NJ") depending on which one answered. Search matches state
// as a plain substring, so "NJ" stored as "New Jersey" would never match a
// search for "NJ" (and vice versa) even though it's the exact right
// property. Normalizing to a single canonical form (2-letter code) at write
// time, regardless of source, keeps every property findable the same way.
const STATE_NAME_TO_CODE = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR', guam: 'GU', 'virgin islands': 'VI',
  'american samoa': 'AS', 'northern mariana islands': 'MP'
};

const VALID_CODES = new Set(Object.values(STATE_NAME_TO_CODE));

// Returns a 2-letter state code whenever the input is recognizable as either
// a code or a full US state name, otherwise returns the input unchanged
// (trimmed) so unrecognized/foreign values aren't silently destroyed.
function normalizeState(state) {
  if (!state) return state;
  const trimmed = state.trim();

  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && VALID_CODES.has(upper)) return upper;

  const byName = STATE_NAME_TO_CODE[trimmed.toLowerCase()];
  if (byName) return byName;

  return trimmed;
}

// Every full state name as a word array, longest first, so "new jersey" is
// recognized as one two-word phrase before "new" alone could be considered.
const STATE_NAME_WORDS = Object.keys(STATE_NAME_TO_CODE)
  .map(name => name.split(' '))
  .sort((a, b) => b.length - a.length);

// Tokenized full-text search matches a query against stored properties
// word-by-word, requiring every word to appear somewhere in the combined
// address/city/state/zip text. A property's state is always stored as a
// 2-letter code (see normalizeState above), but a query built from a
// geocoded address or typed by hand often carries the full name ("New
// Jersey") -- split into separate "New" and "Jersey" words, neither of
// which is a substring of "NJ", so the property silently drops out of
// results even though it's an exact match.
//
// This walks the query's words and, wherever a run of them spells a full
// state name, replaces that run with a single entry carrying both the
// original phrase and its code -- the caller matches EITHER form (an OR),
// rather than the code replacing the phrase outright. That matters because
// a state name can also legitimately be part of an address ("Georgia
// Avenue"); replacing it outright would break matching a property that
// really does contain that literal text, since "Georgia" isn't a substring
// of "GA". Matching either form fixes the common case (a full state name
// standing in for the state) without breaking the rarer one.
function tokenizeAddressQuery(q) {
  const words = q.split(/[\s,]+/)
    .map(w => w.trim().replace(/\.$/, '').replace(/^#/, ''))
    .filter(Boolean);

  const tokens = [];
  for (let i = 0; i < words.length; i++) {
    const stateMatch = STATE_NAME_WORDS.find(nameWords =>
      nameWords.length <= words.length - i &&
      nameWords.every((word, j) => word === words[i + j].toLowerCase())
    );

    if (stateMatch) {
      tokens.push({ text: words.slice(i, i + stateMatch.length).join(' '), altCode: STATE_NAME_TO_CODE[stateMatch.join(' ')] });
      i += stateMatch.length - 1;
    } else {
      tokens.push({ text: words[i], altCode: null });
    }
  }
  return tokens;
}

// Simple OR-based variant for a non-tokenized substring search (e.g.
// "/properties/suggestions", which ILIKE-matches the whole query as one
// string): try the query as typed, and also with any full state name
// swapped for its code, without discarding the original.
function withStateCodeAlternate(text) {
  if (!text) return text;
  const tokens = tokenizeAddressQuery(text);
  return tokens.some(t => t.altCode)
    ? tokens.map(t => t.altCode || t.text).join(' ')
    : text;
}

module.exports = { normalizeState, tokenizeAddressQuery, withStateCodeAlternate };
