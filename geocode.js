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

function nominatimSearch(query, { bias = false } = {}) {
  const encodedQuery = encodeURIComponent(query);
  const viewboxParam = bias ? `&viewbox=${NJ_NY_METRO_VIEWBOX}` : '';
  const url = `https://nominatim.openstreetmap.org/search?q=${encodedQuery}&format=json&limit=1&addressdetails=1${viewboxParam}`;
  const options = { headers: { 'User-Agent': 'RentReviews-Platform/1.0' } };

  return new Promise((resolve) => {
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          resolve(results && results.length > 0 ? results[0] : null);
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.error('Geocoding error:', err);
      resolve(null);
    });
  });
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

    const addr = result.address || {};
    const houseNumber = addr.house_number || '';
    const road = addr.road || '';
    const streetAddress = [houseNumber, road].filter(Boolean).join(' ') || result.display_name.split(',')[0];

    return {
      success: true,
      latitude: parseFloat(result.lat),
      longitude: parseFloat(result.lon),
      display_name: result.display_name,
      address: streetAddress,
      city: addr.city || addr.town || addr.village || addr.hamlet || '',
      state: addr.state || '',
      zip_code: addr.postcode || ''
    };
  } catch (error) {
    console.error('Geocode error:', error);
    return { success: false, reason: error.message };
  }
}

module.exports = { geocodeAddress, geocodeFreeText, delay };
