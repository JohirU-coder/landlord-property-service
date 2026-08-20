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

// How far from the target point to look for a real panorama. Google's own
// default is a tight 50m, which misses plenty of genuinely-covered suburban
// addresses -- a house set back on a cul-de-sac or long driveway can easily
// have its nearest panorama 100-150m away on the actual public road. 200m
// catches those without wandering far enough to snap to an unrelated street.
const SEARCH_RADIUS_METERS = 200;

// Returns { heading, lat, lng } for the nearest real panorama (heading faces
// from that panorama toward the target point), or null if there's no Street
// View coverage nearby, the lookup fails, or the server-side key isn't
// configured. lat/lng are the panorama's own coordinates, NOT the target's --
// callers should request the Static/Embed image AT the panorama's coordinates
// rather than the original target point. Google's Static/Embed APIs do their
// own independent (and similarly tight, default-50m) nearest-panorama snap,
// so if we told them to look at the original target point instead, a
// panorama our own wider-radius metadata search found could still fail to
// render there -- Google returns a "no imagery" placeholder as a normal 200
// response, so that failure wouldn't even surface as an error.
async function getStreetViewHeading(lat, lng) {
  if (!STREETVIEW_SERVER_KEY || lat == null || lng == null) return null;

  try {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&radius=${SEARCH_RADIUS_METERS}&key=${STREETVIEW_SERVER_KEY}`;
    const metadata = await httpsGetJson(url);

    if (metadata.status === 'ZERO_RESULTS') return null; // genuinely no coverage nearby -- expected, not an error

    if (metadata.status !== 'OK' || !metadata.location) {
      // Anything else (REQUEST_DENIED, OVER_QUERY_LIMIT, INVALID_REQUEST,
      // UNKNOWN_ERROR) is a real problem -- a bad/restricted key or an
      // exhausted quota would otherwise silently look identical to "no
      // coverage" everywhere, site-wide, with nothing in the logs to catch it.
      console.error('Street View metadata returned non-OK status:', metadata.status, metadata.error_message || '');
      return null;
    }

    return {
      heading: Math.round(bearingBetween(metadata.location.lat, metadata.location.lng, lat, lng)),
      lat: metadata.location.lat,
      lng: metadata.location.lng
    };
  } catch (error) {
    console.warn('Street View metadata lookup failed:', error.message);
    return null;
  }
}

module.exports = { getStreetViewHeading };
