// Geocoding helper. Google's Geocoding API (commercial, accurate) is tried
// first for the two "give me one authoritative answer" lookups (property
// creation, address-preview); OpenStreetMap Nominatim (free, 1 req/sec rate
// limit) is the fallback if Google's unconfigured/denied/down, and remains
// the sole source for live-as-you-type suggestions, which are much
// higher-volume and lower-stakes than an actual saved/shown address.
const https = require('https');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Same server-side key used for Street View -- just needs the Geocoding API
// added to its enabled APIs (and, if the key has API restrictions, to that
// allowlist too) in Google Cloud Console.
const GOOGLE_GEOCODING_KEY = process.env.GOOGLE_STREETVIEW_SERVER_KEY;

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function componentValue(components, type, useShortName = false) {
  const match = components.find(c => c.types.includes(type));
  if (!match) return '';
  return useShortName ? match.short_name : match.long_name;
}

function toStructuredResultFromGoogle(result) {
  const comps = result.address_components || [];
  const houseNumber = componentValue(comps, 'street_number');
  const road = componentValue(comps, 'route');
  const streetAddress = [houseNumber, road].filter(Boolean).join(' ') || result.formatted_address.split(',')[0];

  return {
    latitude: result.geometry.location.lat,
    longitude: result.geometry.location.lng,
    display_name: result.formatted_address,
    address: streetAddress,
    city: componentValue(comps, 'locality') || componentValue(comps, 'sublocality') || componentValue(comps, 'postal_town') || componentValue(comps, 'administrative_area_level_3') || '',
    state: componentValue(comps, 'administrative_area_level_1', true),
    zip_code: componentValue(comps, 'postal_code', true),
    hasHouseNumber: Boolean(houseNumber)
  };
}

// Not throttled like Nominatim -- Google's Geocoding API is a standard
// commercial API with its own much higher quota, no 1 req/sec policy to
// respect. Returns null (never throws) on any failure so callers can fall
// back to Nominatim transparently.
async function googleGeocode(query) {
  if (!GOOGLE_GEOCODING_KEY) return null;

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:US&key=${GOOGLE_GEOCODING_KEY}`;
    const data = await httpsGetJson(url);

    if (data.status === 'ZERO_RESULTS') return null; // genuinely no match -- expected, not an error

    if (data.status !== 'OK' || !data.results?.length) {
      // REQUEST_DENIED (API not enabled/billing not set up), OVER_QUERY_LIMIT,
      // INVALID_REQUEST, etc. -- a real problem, not "no results". Logged
      // distinctly so a misconfigured/exhausted key doesn't silently look
      // like every address just happens to fall back to Nominatim.
      console.error('Google Geocoding API returned non-OK status:', data.status, data.error_message || '');
      return null;
    }

    // Prefer a real, precise street-level match over a loose route/locality
    // match if Google returned multiple candidates for an ambiguous query.
    const best = data.results.find(r => r.types.includes('street_address') || r.types.includes('premise'))
      || data.results[0];
    return toStructuredResultFromGoogle(best);
  } catch (error) {
    console.warn('Google Geocoding request failed:', error.message);
    return null;
  }
}

// NJ/NY metro area (roughly NYC five boroughs + northern/central NJ + lower
// Hudson Valley), as "left,top,right,bottom" (min_lon,max_lat,max_lon,min_lat).
// Used as a soft ranking bias, not a hard filter — a query that clearly
// resolves elsewhere still returns that result, this just stops ambiguous
// queries (e.g. a bare street name with no city) from randomly matching a
// same-named street in an unrelated state.
const NJ_NY_METRO_VIEWBOX = '-75.5,41.4,-73.5,40.3';

// Global serialization queue — ensures at most ~1 request/second reaches
// Nominatim no matter how many callers ask at once (property creation,
// search-address-preview, live suggestions, concurrent users, ...).
// Required by Nominatim's usage policy; without this, enough simultaneous
// traffic could get our server's IP rate-limited or banned, breaking
// geocoding platform-wide. Callers just await normally — the queue makes
// them wait their turn transparently, never rejects.
const MIN_REQUEST_INTERVAL_MS = 1100;
let requestQueue = Promise.resolve();

function throttled(fn, isAborted) {
  // The caller gets the result as soon as fn() actually resolves — the
  // spacing delay only needs to gate when the *next* queued call is allowed
  // to start, not pad the response time of this one. (An earlier version
  // awaited the delay before returning, which added ~1.1s to every single
  // request even when nothing else was queued.)
  //
  // isAborted is checked right as this item's turn comes up, not when it was
  // queued — live-as-you-type suggestions fire one request per keystroke,
  // and the browser abandons all but the latest as the user keeps typing.
  // Skipped items must NOT pay the MIN_REQUEST_INTERVAL_MS spacing delay —
  // that delay exists only to space out real Nominatim calls. An earlier
  // version applied it unconditionally, so a pile of abandoned requests
  // still serialized at 1.1s each even though none of them hit the network,
  // completely defeating the point of skipping them.
  const turnPromise = requestQueue.then(() => {
    if (isAborted && isAborted()) {
      return { skipped: true, value: [] };
    }
    return fn().then(value => ({ skipped: false, value }));
  });

  requestQueue = turnPromise.then(
    (result) => (result.skipped ? undefined : delay(MIN_REQUEST_INTERVAL_MS)),
    () => delay(MIN_REQUEST_INTERVAL_MS) // still wait even if fn() threw, and don't let the queue itself reject
  );

  return turnPromise.then(result => result.value);
}

function nominatimSearchRaw(query, { bias = false, limit = 1 } = {}, isAborted) {
  return throttled(() => new Promise((resolve) => {
    const encodedQuery = encodeURIComponent(query);
    const viewboxParam = bias ? `&viewbox=${NJ_NY_METRO_VIEWBOX}` : '';
    const url = `https://nominatim.openstreetmap.org/search?q=${encodedQuery}&format=json&limit=${limit}&addressdetails=1${viewboxParam}`;
    const options = { headers: { 'User-Agent': 'RentReviews-Platform/1.0' } };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          resolve(Array.isArray(results) ? results : []);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', (err) => {
      console.error('Geocoding error:', err);
      resolve([]);
    });
  }), isAborted);
}

async function nominatimSearch(query, options = {}) {
  const results = await nominatimSearchRaw(query, { ...options, limit: 1 });
  return results[0] || null;
}

function toStructuredResult(result) {
  const addr = result.address || {};
  const houseNumber = addr.house_number || '';
  const road = addr.road || '';
  const streetAddress = [houseNumber, road].filter(Boolean).join(' ') || result.display_name.split(',')[0];

  return {
    latitude: parseFloat(result.lat),
    longitude: parseFloat(result.lon),
    display_name: result.display_name,
    address: streetAddress,
    city: addr.city || addr.town || addr.village || addr.hamlet || '',
    state: addr.state || '',
    zip_code: addr.postcode || '',
    hasHouseNumber: Boolean(houseNumber)
  };
}

async function geocodeAddress(address, city, state, zipCode) {
  const fullAddress = [address, city, state, zipCode].filter(Boolean).join(', ');

  const googleResult = await googleGeocode(fullAddress);
  if (googleResult) {
    return { success: true, latitude: googleResult.latitude, longitude: googleResult.longitude };
  }

  try {
    const result = await nominatimSearch(fullAddress);

    if (!result) {
      return { success: false, latitude: null, longitude: null, reason: 'No results found' };
    }

    return {
      success: true,
      latitude: parseFloat(result.lat),
      longitude: parseFloat(result.lon)
    };
  } catch (error) {
    console.error('Geocode error:', error);
    return { success: false, latitude: null, longitude: null, reason: error.message };
  }
}

// Free-text address lookup (e.g. "104 Coral Street, Miami, FL") — used when a
// searched address isn't yet a property in our database. Returns structured
// address components so the caller can populate address/city/state/zip_code
// fields without the user re-typing them. Tries Google first (see
// googleGeocode above for why) and falls back to Nominatim.
async function geocodeFreeText(query) {
  const googleResult = await googleGeocode(query);
  if (googleResult) {
    return { success: true, ...googleResult };
  }

  try {
    const result = await nominatimSearch(query, { bias: true });
    if (!result) {
      return { success: false, reason: 'No results found' };
    }

    return { success: true, ...toStructuredResult(result) };
  } catch (error) {
    console.error('Geocode error:', error);
    return { success: false, reason: error.message };
  }
}

// Same idea as geocodeFreeText but returns up to `limit` candidates instead
// of just the top match — used for live-as-you-type suggestions, backed by
// the same accurate data used for the actual search (unlike Photon's
// separate, sparser free index, which has real coverage gaps for some
// addresses). isAborted (optional) lets the caller signal that nobody's
// waiting for this anymore by the time it reaches the front of the queue —
// see throttled() above for why that matters.
async function geocodeFreeTextSuggestions(query, limit = 6, isAborted) {
  try {
    const results = await nominatimSearchRaw(query, { bias: true, limit }, isAborted);
    return results
      .map(toStructuredResult)
      .filter(r => r.hasHouseNumber); // only full addresses, not bare streets/cities
  } catch (error) {
    console.error('Geocode suggestions error:', error);
    return [];
  }
}

module.exports = { geocodeAddress, geocodeFreeText, geocodeFreeTextSuggestions, delay };
