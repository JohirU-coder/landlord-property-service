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

module.exports = { normalizeState };
