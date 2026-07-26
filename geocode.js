// Geocoding helper using OpenStreetMap Nominatim (free, 1 req/sec rate limit)
const https = require('https');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function geocodeAddress(address, city, state, zipCode) {
  try {
    const fullAddress = `${address}, ${city}, ${state} ${zipCode}`;
    const encodedAddress = encodeURIComponent(fullAddress);
    
    return new Promise((resolve, reject) => {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodedAddress}&format=json&limit=1`;
      
      const options = {
        headers: {
          'User-Agent': 'RentReviews-Platform/1.0'
        }
      };
      
      https.get(url, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const results = JSON.parse(data);
            if (results && results.length > 0) {
              resolve({
                success: true,
                latitude: parseFloat(results[0].lat),
                longitude: parseFloat(results[0].lon)
              });
            } else {
              resolve({
                success: false,
                latitude: null,
                longitude: null,
                reason: 'No results found'
              });
            }
          } catch (e) {
            resolve({
              success: false,
              latitude: null,
              longitude: null,
              reason: 'Parse error'
            });
          }
        });
      }).on('error', (err) => {
        console.error('Geocoding error:', err);
        resolve({
          success: false,
          latitude: null,
          longitude: null,
          reason: err.message
        });
      });
    });
  } catch (error) {
    console.error('Geocode error:', error);
    return {
      success: false,
      latitude: null,
      longitude: null,
      reason: error.message
    };
  }
}

module.exports = { geocodeAddress, delay };

