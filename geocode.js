// Geocoding helper using OpenStreetMap Nominatim (free, 1 req/sec rate limit)
const https = require('https');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

function throttled(fn) {
  // The caller gets the result as soon as fn() actually resolves — the
  // spacing delay only needs to gate when the *next* queued call is allowed
  // to start, not pad the response time of this one. (An earlier version
  // awaited the delay before returning, which added ~1.1s to every single
  // request even when nothing else was queued — that was the whole
  // "autocomplete feels slow" bug.)
  const resultPromise = requestQueue.then(fn);
  requestQueue = resultPromise.then(
    () => delay(MIN_REQUEST_INTERVAL_MS),
    () => delay(MIN_REQUEST_INTERVAL_MS) // still wait even if fn() threw, and don't let the queue itself reject
  );
  return resultPromise;
}

function nominatimSearchRaw(query, { bias = false, limit = 1 } = {}) {
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
  }));
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
  try {
    const fullAddress = [address, city, state, zipCode].filter(Boolean).join(', ');
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
// searched address isn't yet a property in our database. Returns Nominatim's
// structured address components so the caller can populate address/city/
// state/zip_code fields without the user re-typing them.
async function geocodeFreeText(query) {
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
// addresses). Safe to call per-keystroke-ish now that requests are globally
// throttled above; the caller should still debounce to keep volume sane.
async function geocodeFreeTextSuggestions(query, limit = 4) {
  try {
    const results = await nominatimSearchRaw(query, { bias: true, limit });
    return results
      .map(toStructuredResult)
      .filter(r => r.hasHouseNumber); // only full addresses, not bare streets/cities
  } catch (error) {
    console.error('Geocode suggestions error:', error);
    return [];
  }
}

module.exports = { geocodeAddress, geocodeFreeText, geocodeFreeTextSuggestions, delay };
