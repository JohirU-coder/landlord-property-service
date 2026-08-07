// Computes the Street View camera heading that actually faces a property,
// instead of Google's default (arbitrary) panorama orientation. Without an
// explicit heading, the Static/Embed APIs just use whatever direction the
// camera happened to be pointing when the car drove by — could be down the
// street, at a neighbor's house, anywhere.
//
// Approach: look up the nearest real panorama's coordinates via the (free)
// Street View Metadata API, then compute the compass bearing from that
// panorama to the property's coordinates — that's the heading that looks
// at the building.
const https = require('https');

const STREETVIEW_SERVER_KEY = process.env.GOOGLE_STREETVIEW_SERVER_KEY;

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

// Compass bearing (0-360 degrees) from point 1 to point 2.
function bearingBetween(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => deg * Math.PI / 180;
  const toDeg = (rad) => rad * 180 / Math.PI;

  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Returns the heading in degrees, or null if there's no Street View coverage
// nearby, the lookup fails, or the server-side key isn't configured.
async function getStreetViewHeading(lat, lng) {
  if (!STREETVIEW_SERVER_KEY || lat == null || lng == null) return null;

  try {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${STREETVIEW_SERVER_KEY}`;
    const metadata = await httpsGetJson(url);

    if (metadata.status !== 'OK' || !metadata.location) return null;

    return Math.round(bearingBetween(metadata.location.lat, metadata.location.lng, lat, lng));
  } catch (error) {
    console.warn('Street View metadata lookup failed:', error.message);
    return null;
  }
}

module.exports = { getStreetViewHeading };
