require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const Joi = require('joi');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { geocodeAddress, geocodeFreeText, geocodeFreeTextSuggestions, delay } = require('./geocode');
const { getStreetViewHeading } = require('./streetView');
const { normalizeState, tokenizeAddressQuery, withStateCodeAlternate } = require('./stateNormalize');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3002;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// JWT auth — matches auth-service's generateToken() exactly (same JWT_SECRET,
// same payload shape: { id, email, role, firstName, lastName, email_verified }).
// Property ownership is derived from the token instead of trusting a
// client-supplied landlord_id.
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access denied', message: 'No token provided' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token', message: 'Token is invalid or expired' });
    }
    req.user = user;
    next();
  });
};

const requireRole = (roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      error: 'Insufficient permissions',
      message: `This endpoint requires ${roles.join(' or ')} role`
    });
  }
  next();
};

// Rate limits for the two endpoints unauthenticated/any-role traffic can
// reach — geocoding hits a free third-party service, and community-submit
// creates DB rows without landlord-role gating, so both need spam guards.
const geocodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests', message: 'Please slow down and try again shortly' }
});

const communitySubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests', message: 'Maximum 10 property submissions per hour' }
});

// Validation schema for community-submitted properties — minimal fields,
// no rent/bedroom details required since the submitter is a renter who
// just wants to review an address, not a landlord listing it.
const communityPropertySchema = Joi.object({
  address: Joi.string().required().min(5).max(500),
  city: Joi.string().required().min(2).max(100),
  state: Joi.string().required().min(2).max(50),
  zip_code: Joi.string().required().pattern(/^\d{5}(-\d{4})?$/)
});

// Validation schema for property creation — landlord_id is no longer accepted
// from the client; it's derived from the authenticated user's token.
const createPropertySchema = Joi.object({
  address: Joi.string().required().min(5).max(500),
  city: Joi.string().required().min(2).max(100),
  state: Joi.string().required().min(2).max(50),
  zip_code: Joi.string().required().pattern(/^\d{5}(-\d{4})?$/), // US zip code format
  rent_amount: Joi.number().positive().precision(2).max(50000), // Max $50k rent
  bedrooms: Joi.number().integer().min(0).max(20),
  bathrooms: Joi.number().positive().precision(1).max(20),
  square_feet: Joi.number().integer().positive().max(50000),
  description: Joi.string().max(2000)
});

app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:3000',
    'https://rentreviews.net',
    'https://www.rentreviews.net'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  // Accept is spec-safelisted, so Chrome lets a preflight through without it
  // being explicitly listed here -- Safari/WebKit is stricter and enforces
  // it anyway, so a request sending an explicit Accept header (like
  // add-property.html's POST /properties) fails CORS in Safari specifically
  // while working fine in Chrome.
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
app.use(express.json());

// Gates schema-setup/admin endpoints -- matches auth-service's pattern.
const requireAdminSecret = (req, res, next) => {
  const secret = req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
  }
  next();
};

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'property-service',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Landlord Property Service API',
    status: 'running',
    endpoints: {
      health: '/health',
      'setup-database': '/setup-database (GET)',
      'add-property': '/properties (POST)',
      'search-properties': '/properties (GET)',
      'property-suggestions': '/properties/suggestions (GET)',
      'geocode-backfill': '/admin/geocode-properties (POST)',
      'normalize-states': '/admin/normalize-states (POST)',
      test: '/test'
    }
  });
});

app.get('/test', (req, res) => {
  res.json({
    message: 'Property service test endpoint working!',
    database: process.env.DATABASE_URL ? 'Connected' : 'Not configured',
    port: PORT
  });
});

app.get('/setup-database', requireAdminSecret, async (req, res) => {
  try {
    // Create properties table with latitude/longitude
    await pool.query(`
      CREATE TABLE IF NOT EXISTS properties (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        city VARCHAR(100) NOT NULL,
        state VARCHAR(50) NOT NULL,
        zip_code VARCHAR(20) NOT NULL,
        latitude DECIMAL(10, 8),
        longitude DECIMAL(11, 8),
        rent_amount DECIMAL(10,2),
        bedrooms INTEGER,
        bathrooms DECIMAL(3,1),
        square_feet INTEGER,
        description TEXT,
        landlord_id INTEGER REFERENCES users(id),
        landlord_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Add latitude/longitude columns if they don't exist (for existing tables)
    await pool.query(`
      ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 8),
      ADD COLUMN IF NOT EXISTS longitude DECIMAL(11, 8),
      ADD COLUMN IF NOT EXISTS street_view_heading DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS street_view_lat DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS street_view_lng DOUBLE PRECISION;
    `);
    
    res.json({ 
      message: 'Properties table created successfully!',
      table: 'properties',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Database setup error:', error);
    res.status(500).json({ 
      error: 'Failed to create properties table', 
      details: error.message 
    });
  }
});

// GET /geocode - Free-text address lookup (PUBLIC, no DB write). Used by the
// search page to preview an address (with a Street View image) before
// anyone commits to adding it as a property.
app.get('/geocode', geocodeLimiter, async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Missing query', message: 'q parameter is required' });
  }

  const result = await geocodeFreeText(query);
  if (!result.success) {
    return res.status(404).json({ error: 'Not found', message: 'Could not find that address' });
  }

  const streetView = await getStreetViewHeading(result.latitude, result.longitude);
  res.json({
    success: true,
    ...result,
    street_view_heading: streetView?.heading ?? null,
    street_view_lat: streetView?.lat ?? null,
    street_view_lng: streetView?.lng ?? null
  });
});

// GET /geocode/suggestions - Live-as-you-type address suggestions (PUBLIC).
// Backed by the same accurate Nominatim data used for the actual search,
// unlike the frontend's primary autocomplete source (Photon), whose free
// index has real coverage gaps for some addresses. Requests are globally
// throttled to Nominatim's 1 req/sec limit inside geocode.js regardless of
// how many people are typing at once, so this is safe to hit frequently —
// the frontend should still debounce so results don't queue up needlessly.
const suggestionsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  message: { error: 'Too many requests', message: 'Please slow down and try again shortly' }
});

app.get('/geocode/suggestions', suggestionsLimiter, async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query || query.length < 2) {
    return res.json({ success: true, suggestions: [] });
  }

  // The frontend fires one request per keystroke (debounced) and abandons
  // all but the latest as the user keeps typing. Track that so a request
  // that's already been abandoned skips its Nominatim call entirely once it
  // reaches the front of the throttle queue, instead of occupying a slot
  // nobody's waiting on — see throttled() in geocode.js for why this matters.
  let clientDisconnected = false;
  req.on('close', () => { clientDisconnected = true; });

  const suggestions = await geocodeFreeTextSuggestions(query, 8, () => clientDisconnected);
  if (clientDisconnected) return; // nothing to send to a closed connection
  res.json({ success: true, suggestions });
});

// GET /properties/suggestions - Live-as-you-type suggestions sourced from
// OUR OWN listed properties (PUBLIC). Both /geocode/suggestions and the
// frontend's Photon calls only know about the general real-world address
// universe -- neither has any idea what's actually listed here, so an
// address that's already a property in this database had no fast,
// guaranteed path into the autocomplete dropdown at all. This is a plain
// local DB query (no external API, no rate-limit queue), so it's the
// fastest of the three suggestion sources by a wide margin and always
// accurate for what's actually listed -- the frontend gives it top
// priority in the merged dropdown for exactly that reason.
//
// GET /properties/stats is defined here too (before /properties/:id below)
// for the same reason: Express matches routes in registration order, and
// /properties/:id would otherwise catch a request for "/properties/stats"
// first, try to parse "stats" as a numeric ID, and fail with "Invalid
// property ID" -- which is exactly what was happening here until this was
// moved (found while wiring the homepage's live stats display up to this
// endpoint for the first time; it had apparently never been reachable).
app.get('/properties/stats', async (req, res) => {
  try {
    // No WHERE clause here on purpose -- this used to filter to
    // rent_amount IS NOT NULL, which was meant to keep the rent
    // average/min/max meaningful (aggregates like AVG/MIN/MAX already skip
    // NULL rows on their own, so that filter was never actually needed for
    // them) but had the side effect of also excluding those properties from
    // total_properties, verified_properties, and the city/state counts --
    // every community-submitted property (the /properties/community path,
    // which never collects rent_amount) was invisible to this endpoint,
    // undercounting the real total. Found immediately after fixing the
    // route-ordering bug that had made this endpoint unreachable: it came
    // back reporting 0 total properties despite 4 real ones existing.
    const statsQuery = `
      SELECT
        COUNT(*) as total_properties,
        COUNT(CASE WHEN landlord_verified = true THEN 1 END) as verified_properties,
        AVG(rent_amount) as avg_rent,
        MIN(rent_amount) as min_rent,
        MAX(rent_amount) as max_rent,
        AVG(bedrooms) as avg_bedrooms,
        AVG(bathrooms) as avg_bathrooms,
        AVG(square_feet) as avg_sqft,
        COUNT(DISTINCT city) as cities_count,
        COUNT(DISTINCT state) as states_count
      FROM properties
    `;

    const result = await pool.query(statsQuery);
    const stats = result.rows[0];

    res.json({
      success: true,
      statistics: {
        total_properties: parseInt(stats.total_properties),
        verified_properties: parseInt(stats.verified_properties),
        verification_rate: stats.total_properties > 0
          ? Math.round((stats.verified_properties / stats.total_properties) * 100)
          : 0,
        rent_statistics: {
          average: stats.avg_rent ? Math.round(parseFloat(stats.avg_rent)) : null,
          minimum: stats.min_rent ? parseFloat(stats.min_rent) : null,
          maximum: stats.max_rent ? parseFloat(stats.max_rent) : null
        },
        property_features: {
          avg_bedrooms: stats.avg_bedrooms ? Math.round(parseFloat(stats.avg_bedrooms) * 10) / 10 : null,
          avg_bathrooms: stats.avg_bathrooms ? Math.round(parseFloat(stats.avg_bathrooms) * 10) / 10 : null,
          avg_square_feet: stats.avg_sqft ? Math.round(parseFloat(stats.avg_sqft)) : null
        },
        geographic_coverage: {
          cities: parseInt(stats.cities_count),
          states: parseInt(stats.states_count)
        }
      }
    });

  } catch (error) {
    console.error('Error fetching property statistics:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch property statistics'
    });
  }
});

app.get('/properties/suggestions', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query || query.length < 2) {
    return res.json({ success: true, suggestions: [] });
  }

  try {
    // Matches the query as typed, and also with any full state name
    // ("New Jersey") swapped for its stored code ("NJ") -- properties are
    // always stored with the 2-letter code, so a query carrying the full
    // name would otherwise never match. See stateNormalize.js.
    const result = await pool.query(
      `SELECT id, address, city, state, zip_code, latitude, longitude, street_view_heading, street_view_lat, street_view_lng
       FROM properties
       WHERE (address || ' ' || city || ' ' || state || ' ' || zip_code) ILIKE '%' || $1 || '%'
          OR (address || ' ' || city || ' ' || state || ' ' || zip_code) ILIKE '%' || $2 || '%'
       ORDER BY created_at DESC
       LIMIT 8`,
      [query, withStateCodeAlternate(query)]
    );
    res.json({ success: true, suggestions: result.rows });
  } catch (error) {
    console.error('Error fetching property suggestions:', error);
    res.json({ success: true, suggestions: [] }); // best-effort -- a failure here shouldn't break the other two sources
  }
});

// POST /properties/community - Find-or-create a minimal, unverified property
// record so a renter can review an address that isn't in our database yet.
// Open to any authenticated user (not landlord-only) since the whole point
// is letting renters review properties no landlord has listed.
app.post('/properties/community', authenticateToken, communitySubmitLimiter, async (req, res) => {
  try {
    // Re-check verification status live against the DB rather than trusting
    // the JWT -- a token issued before email verification became required
    // (or before this account got verified) would otherwise still work for
    // the rest of its 7-day lifetime.
    const verifiedCheck = await pool.query('SELECT email_verified FROM users WHERE id = $1', [req.user.id]);
    if (verifiedCheck.rows.length === 0 || !verifiedCheck.rows[0].email_verified) {
      return res.status(403).json({
        error: 'Email not verified',
        message: 'Please verify your email before submitting a property.'
      });
    }

    const { error, value } = communityPropertySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(detail => detail.message)
      });
    }

    const { address, city, zip_code } = value;
    // Community-submitted addresses come from the geocoder, which can return
    // either a full state name (Nominatim) or an abbreviation (Google)
    // depending on which one answered -- normalize so every property is
    // findable the same way regardless of source. See stateNormalize.js.
    const state = normalizeState(value.state);

    // Idempotent: if this address already exists (landlord-listed or
    // previously community-submitted), just return it instead of duplicating.
    const existing = await pool.query(
      'SELECT * FROM properties WHERE LOWER(address) = LOWER($1) AND zip_code = $2',
      [address, zip_code]
    );

    if (existing.rows.length > 0) {
      return res.json({ success: true, property: existing.rows[0], already_existed: true });
    }

    let latitude = null;
    let longitude = null;
    let streetViewHeading = null;
    let streetViewLat = null;
    let streetViewLng = null;
    try {
      const geocodeResult = await geocodeAddress(address, city, state, zip_code);
      if (geocodeResult.success) {
        latitude = geocodeResult.latitude;
        longitude = geocodeResult.longitude;
        const streetView = await getStreetViewHeading(latitude, longitude);
        streetViewHeading = streetView?.heading ?? null;
        streetViewLat = streetView?.lat ?? null;
        streetViewLng = streetView?.lng ?? null;
      }
    } catch (geocodeErr) {
      console.warn('Geocoding failed for community property, continuing without coords:', geocodeErr);
    }

    const result = await pool.query(
      `INSERT INTO properties (address, city, state, zip_code, latitude, longitude, street_view_heading, street_view_lat, street_view_lng, landlord_id, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10)
       RETURNING *`,
      [address, city, state, zip_code, latitude, longitude, streetViewHeading, streetViewLat, streetViewLng,
        '[Community-Submitted Property - Unverified by Landlord]']
    );

    res.status(201).json({ success: true, property: result.rows[0], already_existed: false });
  } catch (error) {
    console.error('Error creating community property:', error);
    res.status(500).json({ error: 'Internal server error', message: 'Failed to add property' });
  }
});

// POST /properties - Create a new property (requires landlord auth)
app.post('/properties', authenticateToken, requireRole(['landlord']), async (req, res) => {
  try {
    // Re-check verification status live against the DB rather than trusting
    // the JWT -- a token issued before email verification became required
    // (or before this account got verified) would otherwise still work for
    // the rest of its 7-day lifetime.
    const verifiedCheck = await pool.query('SELECT email_verified FROM users WHERE id = $1', [req.user.id]);
    if (verifiedCheck.rows.length === 0 || !verifiedCheck.rows[0].email_verified) {
      return res.status(403).json({
        error: 'Email not verified',
        message: 'Please verify your email before adding a property.'
      });
    }

    // Validate request body
    const { error, value } = createPropertySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(detail => detail.message)
      });
    }

    const {
      address,
      city,
      zip_code,
      rent_amount,
      bedrooms,
      bathrooms,
      square_feet,
      description
    } = value;
    // Defense-in-depth: the form's own <select> always sends a 2-letter
    // code, but normalize here too in case this endpoint is ever hit
    // directly with a full state name. See stateNormalize.js.
    const state = normalizeState(value.state);

    const landlord_id = req.user.id;

    // Verify the landlord exists and is actually a landlord
    const landlordCheck = await pool.query(
      'SELECT id, role FROM users WHERE id = $1',
      [landlord_id]
    );

    if (landlordCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'Landlord not found',
        message: 'The specified landlord_id does not exist'
      });
    }

    const landlord = landlordCheck.rows[0];
    if (landlord.role !== 'landlord') {
      return res.status(403).json({
        error: 'Invalid user role',
        message: 'Only users with landlord role can create properties'
      });
    }

    // Check for duplicate property (same address + zip)
    const duplicateCheck = await pool.query(
      'SELECT id FROM properties WHERE LOWER(address) = LOWER($1) AND zip_code = $2',
      [address, zip_code]
    );

    if (duplicateCheck.rows.length > 0) {
      return res.status(409).json({
        error: 'Property already exists',
        message: 'A property with this address and zip code already exists',
        existing_property_id: duplicateCheck.rows[0].id
      });
    }

    // Try to geocode (best-effort, doesn't block save)
    let latitude = null;
    let longitude = null;
    let streetViewHeading = null;
    let streetViewLat = null;
    let streetViewLng = null;
    try {
      const geocodeResult = await geocodeAddress(address, city, state, zip_code);
      if (geocodeResult.success) {
        latitude = geocodeResult.latitude;
        longitude = geocodeResult.longitude;
        const streetView = await getStreetViewHeading(latitude, longitude);
        streetViewHeading = streetView?.heading ?? null;
        streetViewLat = streetView?.lat ?? null;
        streetViewLng = streetView?.lng ?? null;
      }
    } catch (geocodeErr) {
      console.warn('Geocoding failed for property, continuing without coords:', geocodeErr);
    }

    // Insert the new property
    const insertQuery = `
      INSERT INTO properties (
        address, city, state, zip_code, latitude, longitude, street_view_heading, street_view_lat, street_view_lng, rent_amount,
        bedrooms, bathrooms, square_feet, description, landlord_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `;

    const result = await pool.query(insertQuery, [
      address,
      city,
      state,
      zip_code,
      latitude,
      longitude,
      streetViewHeading,
      streetViewLat,
      streetViewLng,
      rent_amount,
      bedrooms,
      bathrooms,
      square_feet,
      description,
      landlord_id
    ]);

    const newProperty = result.rows[0];

    // Return success response with property details
    res.status(201).json({
      success: true,
      message: 'Property created successfully',
      property: {
        id: newProperty.id,
        address: newProperty.address,
        city: newProperty.city,
        state: newProperty.state,
        zip_code: newProperty.zip_code,
        latitude: newProperty.latitude,
        longitude: newProperty.longitude,
        street_view_heading: newProperty.street_view_heading,
        street_view_lat: newProperty.street_view_lat,
        street_view_lng: newProperty.street_view_lng,
        rent_amount: newProperty.rent_amount,
        bedrooms: newProperty.bedrooms,
        bathrooms: newProperty.bathrooms,
        square_feet: newProperty.square_feet,
        description: newProperty.description,
        landlord_id: newProperty.landlord_id,
        landlord_verified: newProperty.landlord_verified,
        created_at: newProperty.created_at
      }
    });

  } catch (error) {
    console.error('Error creating property:', error);
    
    // Handle specific database errors
    if (error.code === '23503') { // Foreign key violation
      return res.status(400).json({
        error: 'Invalid landlord_id',
        message: 'The specified landlord does not exist'
      });
    }

    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create property'
    });
  }
});

// GET /properties/:id - Get a specific property by ID
app.get('/properties/:id', async (req, res) => {
  try {
    const propertyId = parseInt(req.params.id);
    
    if (isNaN(propertyId)) {
      return res.status(400).json({
        error: 'Invalid property ID',
        message: 'Property ID must be a number'
      });
    }

    // Get property with landlord information
    const query = `
      SELECT 
        p.*,
        u.first_name as landlord_first_name,
        u.last_name as landlord_last_name,
        u.email as landlord_email
      FROM properties p
      LEFT JOIN users u ON p.landlord_id = u.id
      WHERE p.id = $1
    `;

    const result = await pool.query(query, [propertyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Property not found',
        message: 'No property found with the specified ID'
      });
    }

    const property = result.rows[0];

    res.json({
      success: true,
      property: {
        id: property.id,
        address: property.address,
        city: property.city,
        state: property.state,
        zip_code: property.zip_code,
        latitude: property.latitude,
        longitude: property.longitude,
        street_view_heading: property.street_view_heading,
        street_view_lat: property.street_view_lat,
        street_view_lng: property.street_view_lng,
        rent_amount: property.rent_amount,
        bedrooms: property.bedrooms,
        bathrooms: property.bathrooms,
        square_feet: property.square_feet,
        description: property.description,
        landlord_verified: property.landlord_verified,
        created_at: property.created_at,
        landlord: {
          id: property.landlord_id,
          first_name: property.landlord_first_name,
          last_name: property.landlord_last_name,
          email: property.landlord_email
        }
      }
    });

  } catch (error) {
    console.error('Error fetching property:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch property'
    });
  }
});

// Validation schema for property search query parameters
const searchPropertiesSchema = Joi.object({
  // Free-text search across address/city/state/zip combined — lets a full
  // address (from autocomplete) match an existing property even though no
  // single column contains the whole string. See tokenized matching below.
  q: Joi.string().trim().min(1).max(300),
  city: Joi.string().min(2).max(100),
  state: Joi.string().min(2).max(50),
  zip_code: Joi.string().pattern(/^\d{5}(-\d{4})?$/),
  min_rent: Joi.number().positive().max(50000),
  max_rent: Joi.number().positive().max(50000),
  min_bedrooms: Joi.number().integer().min(0).max(20),
  max_bedrooms: Joi.number().integer().min(0).max(20),
  min_bathrooms: Joi.number().positive().precision(1).max(20),
  max_bathrooms: Joi.number().positive().precision(1).max(20),
  min_sqft: Joi.number().integer().positive().max(50000),
  max_sqft: Joi.number().integer().positive().max(50000),
  landlord_verified: Joi.boolean(),
  // "Near me" search -- when both are present, results are filtered to
  // properties with known coordinates and can be sorted by distance from
  // this point (sort_by=distance).
  lat: Joi.number().min(-90).max(90),
  lng: Joi.number().min(-180).max(180),
  sort_by: Joi.string().valid('rent_asc', 'rent_desc', 'newest', 'oldest', 'sqft_asc', 'sqft_desc', 'distance'),
  limit: Joi.number().integer().min(1).max(100).default(20),
  offset: Joi.number().integer().min(0).default(0)
}).custom((value, helpers) => {
  // Custom validation to ensure logical ranges
  if (value.min_rent && value.max_rent && value.min_rent >= value.max_rent) {
    return helpers.error('custom.rentRange');
  }
  if (value.min_bedrooms !== undefined && value.max_bedrooms !== undefined && value.min_bedrooms > value.max_bedrooms) {
    return helpers.error('custom.bedroomsRange');
  }
  if (value.min_bathrooms && value.max_bathrooms && value.min_bathrooms > value.max_bathrooms) {
    return helpers.error('custom.bathroomsRange');
  }
  if (value.min_sqft && value.max_sqft && value.min_sqft > value.max_sqft) {
    return helpers.error('custom.sqftRange');
  }
  return value;
}, 'Range validation').messages({
  'custom.rentRange': 'min_rent must be less than max_rent',
  'custom.bedroomsRange': 'min_bedrooms must be less than or equal to max_bedrooms',
  'custom.bathroomsRange': 'min_bathrooms must be less than max_bathrooms',
  'custom.sqftRange': 'min_sqft must be less than max_sqft'
});

// GET /properties - Search properties with filtering
app.get('/properties', async (req, res) => {
  try {
    // Validate query parameters
    const { error, value } = searchPropertiesSchema.validate(req.query);
    if (error) {
      return res.status(400).json({
        error: 'Invalid search parameters',
        details: error.details.map(detail => detail.message)
      });
    }

    const {
      q,
      city,
      state,
      zip_code,
      min_rent,
      max_rent,
      min_bedrooms,
      max_bedrooms,
      min_bathrooms,
      max_bathrooms,
      min_sqft,
      max_sqft,
      landlord_verified,
      lat,
      lng,
      sort_by = 'newest',
      limit = 20,
      offset = 0
    } = value;

    // Build dynamic WHERE clause
    let whereConditions = [];
    let queryParams = [];
    let paramCount = 0;

    if (lat !== undefined && lng !== undefined) {
      // No placeholders needed -- shared by both the search and count
      // queries, unlike the distance values themselves (see below).
      whereConditions.push('p.latitude IS NOT NULL AND p.longitude IS NOT NULL');
    }

    // Free-text search: a full address string (e.g. "104 Coral Street,
    // Miami, FL 33101" from autocomplete) won't match any single column, so
    // split it into tokens and require each to appear somewhere across the
    // combined address/city/state/zip text — order- and field-independent.
    // tokenizeAddressQuery also strips a trailing period ("St." -> "St")
    // and a leading "#" ("#4B" -> "4B") per word -- punctuation a person
    // naturally types when abbreviating a street suffix or unit number, but
    // that never actually appears in a stored address, so it would
    // otherwise fail an exact-substring match against an address that's
    // really a fine match. It also recognizes a full state name ("New
    // Jersey") as one unit and matches either that phrase or its stored
    // 2-letter code, since requiring "New" AND "Jersey" to each separately
    // appear would never match a state column that only ever holds "NJ".
    if (q) {
      const tokens = tokenizeAddressQuery(q);
      for (const token of tokens) {
        paramCount++;
        if (token.altCode) {
          const phraseParam = paramCount;
          paramCount++;
          const codeParam = paramCount;
          whereConditions.push(`
            ((p.address || ' ' || p.city || ' ' || p.state || ' ' || p.zip_code) ILIKE $${phraseParam}
             OR p.state ILIKE $${codeParam})
          `);
          queryParams.push(`%${token.text}%`);
          queryParams.push(token.altCode);
        } else {
          whereConditions.push(`
            (p.address || ' ' || p.city || ' ' || p.state || ' ' || p.zip_code) ILIKE $${paramCount}
          `);
          queryParams.push(`%${token.text}%`);
        }
      }
    }

    // Add filters based on provided parameters
    if (city) {
      paramCount++;
      whereConditions.push(`LOWER(p.city) LIKE LOWER($${paramCount})`);
      queryParams.push(`%${city}%`);
    }

    if (state) {
      paramCount++;
      whereConditions.push(`LOWER(p.state) = LOWER($${paramCount})`);
      queryParams.push(normalizeState(state));
    }

    if (zip_code) {
      paramCount++;
      whereConditions.push(`p.zip_code = $${paramCount}`);
      queryParams.push(zip_code);
    }

    if (min_rent !== undefined) {
      paramCount++;
      whereConditions.push(`p.rent_amount >= $${paramCount}`);
      queryParams.push(min_rent);
    }

    if (max_rent !== undefined) {
      paramCount++;
      whereConditions.push(`p.rent_amount <= $${paramCount}`);
      queryParams.push(max_rent);
    }

    if (min_bedrooms !== undefined) {
      paramCount++;
      whereConditions.push(`p.bedrooms >= $${paramCount}`);
      queryParams.push(min_bedrooms);
    }

    if (max_bedrooms !== undefined) {
      paramCount++;
      whereConditions.push(`p.bedrooms <= $${paramCount}`);
      queryParams.push(max_bedrooms);
    }

    if (min_bathrooms !== undefined) {
      paramCount++;
      whereConditions.push(`p.bathrooms >= $${paramCount}`);
      queryParams.push(min_bathrooms);
    }

    if (max_bathrooms !== undefined) {
      paramCount++;
      whereConditions.push(`p.bathrooms <= $${paramCount}`);
      queryParams.push(max_bathrooms);
    }

    if (min_sqft !== undefined) {
      paramCount++;
      whereConditions.push(`p.square_feet >= $${paramCount}`);
      queryParams.push(min_sqft);
    }

    if (max_sqft !== undefined) {
      paramCount++;
      whereConditions.push(`p.square_feet <= $${paramCount}`);
      queryParams.push(max_sqft);
    }

    if (landlord_verified !== undefined) {
      paramCount++;
      whereConditions.push(`p.landlord_verified = $${paramCount}`);
      queryParams.push(landlord_verified);
    }

    // Every param up to here is referenced somewhere in whereConditions, so
    // the count query (which shares whereClause but has no SELECT list of
    // its own) needs exactly this many -- snapshot it before adding params
    // that are only used in the search query's SELECT/ORDER BY/LIMIT.
    const whereParamCount = paramCount;

    // "Near me" search -- Haversine distance in miles from (lat, lng). Only
    // used in the SELECT list (and ORDER BY, for sort_by=distance), never in
    // whereConditions, so these placeholders must come after whereParamCount
    // above or the count query ends up with unreferenced extra params and
    // Postgres rejects the whole query.
    let distanceSelectExpr = 'NULL';
    if (lat !== undefined && lng !== undefined) {
      paramCount++;
      const latParam = paramCount;
      queryParams.push(lat);
      paramCount++;
      const lngParam = paramCount;
      queryParams.push(lng);

      distanceSelectExpr = `(3959 * acos(
        LEAST(1, GREATEST(-1,
          cos(radians($${latParam})) * cos(radians(p.latitude)) *
          cos(radians(p.longitude) - radians($${lngParam})) +
          sin(radians($${latParam})) * sin(radians(p.latitude))
        ))
      ))`;
    }

    // Build WHERE clause
    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Build ORDER BY clause
    let orderClause;
    switch (sort_by) {
      case 'distance':
        // Falls back to newest if requested without coordinates -- distance
        // is meaningless without a point to measure from.
        orderClause = (lat !== undefined && lng !== undefined)
          ? 'ORDER BY distance_miles ASC NULLS LAST'
          : 'ORDER BY p.created_at DESC';
        break;
      case 'rent_asc':
        orderClause = 'ORDER BY p.rent_amount ASC NULLS LAST';
        break;
      case 'rent_desc':
        orderClause = 'ORDER BY p.rent_amount DESC NULLS LAST';
        break;
      case 'oldest':
        orderClause = 'ORDER BY p.created_at ASC';
        break;
      case 'sqft_asc':
        orderClause = 'ORDER BY p.square_feet ASC NULLS LAST';
        break;
      case 'sqft_desc':
        orderClause = 'ORDER BY p.square_feet DESC NULLS LAST';
        break;
      case 'newest':
      default:
        orderClause = 'ORDER BY p.created_at DESC';
        break;
    }

    // Add pagination parameters
    paramCount++;
    const limitParam = `$${paramCount}`;
    queryParams.push(limit);
    
    paramCount++;
    const offsetParam = `$${paramCount}`;
    queryParams.push(offset);

    // Main search query
    const searchQuery = `
      SELECT 
        p.id,
        p.address,
        p.city,
        p.state,
        p.zip_code,
        p.latitude,
        p.longitude,
        p.street_view_heading,
        p.street_view_lat,
        p.street_view_lng,
        p.rent_amount,
        p.bedrooms,
        p.bathrooms,
        p.square_feet,
        p.description,
        p.landlord_verified,
        p.created_at,
        ${distanceSelectExpr} AS distance_miles,
        u.first_name as landlord_first_name,
        u.last_name as landlord_last_name,
        u.email as landlord_email,
        COUNT(r.id) as review_count,
        AVG(r.overall_rating) as avg_rating,
        (
          SELECT rp.filename FROM review_photos rp
          JOIN reviews rv ON rv.id = rp.review_id
          WHERE rv.property_id = p.id
          ORDER BY rp.created_at DESC
          LIMIT 1
        ) as photo_filename
      FROM properties p
      LEFT JOIN users u ON p.landlord_id = u.id
      LEFT JOIN reviews r ON r.property_id = p.id
      ${whereClause}
      GROUP BY p.id, u.id
      -- A community-submitted property (no landlord_id) with zero reviews is
      -- just a stub created the moment someone started reviewing an address
      -- and never finished -- it's not a real listing, so it shouldn't
      -- clutter search/browse results. Once it has a review it's real
      -- content and shows normally; a landlord-listed property always shows
      -- regardless of review count, since that's a deliberate listing.
      HAVING NOT (p.landlord_id IS NULL AND COUNT(r.id) = 0)
      ${orderClause}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    // Count query for pagination metadata -- mirrors the same review-backed
    // filter as the main query above so the total/page count actually
    // matches what gets returned.
    const countQuery = `
      SELECT COUNT(*) as total FROM (
        SELECT p.id
        FROM properties p
        LEFT JOIN users u ON p.landlord_id = u.id
        LEFT JOIN reviews r ON r.property_id = p.id
        ${whereClause}
        GROUP BY p.id
        HAVING NOT (p.landlord_id IS NULL AND COUNT(r.id) = 0)
      ) sub
    `;

    // Execute both queries
    const [searchResult, countResult] = await Promise.all([
      pool.query(searchQuery, queryParams),
      pool.query(countQuery, queryParams.slice(0, whereParamCount)) // Only the params whereClause actually references
    ]);

    const properties = searchResult.rows;
    const totalCount = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalCount / limit);
    const currentPage = Math.floor(offset / limit) + 1;

    // Format response
    const formattedProperties = properties.map(property => ({
      id: property.id,
      address: property.address,
      city: property.city,
      state: property.state,
      zip_code: property.zip_code,
      latitude: property.latitude,
      longitude: property.longitude,
      street_view_heading: property.street_view_heading,
      street_view_lat: property.street_view_lat,
      street_view_lng: property.street_view_lng,
      rent_amount: property.rent_amount,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      square_feet: property.square_feet,
      description: property.description,
      landlord_verified: property.landlord_verified,
      created_at: property.created_at,
      distance_miles: property.distance_miles != null ? Math.round(parseFloat(property.distance_miles) * 10) / 10 : null,
      landlord: {
        first_name: property.landlord_first_name,
        last_name: property.landlord_last_name,
        email: property.landlord_email
      },
      review_stats: {
        count: parseInt(property.review_count) || 0,
        avg_rating: property.avg_rating ? Math.round(parseFloat(property.avg_rating) * 10) / 10 : null
      },
      // Relative path on review-service's static /photos route — prefix with
      // REVIEW_API_BASE_URL client-side (property-service doesn't know
      // review-service's public URL).
      photo_path: property.photo_filename ? `/photos/${property.photo_filename}` : null
    }));

    res.json({
      success: true,
      properties: formattedProperties,
      pagination: {
        total_count: totalCount,
        total_pages: totalPages,
        current_page: currentPage,
        limit: limit,
        offset: offset,
        has_next: currentPage < totalPages,
        has_previous: currentPage > 1
      },
      filters_applied: {
        q,
        city,
        state,
        zip_code,
        rent_range: min_rent || max_rent ? { min: min_rent, max: max_rent } : null,
        bedrooms_range: min_bedrooms !== undefined || max_bedrooms !== undefined ? { min: min_bedrooms, max: max_bedrooms } : null,
        bathrooms_range: min_bathrooms || max_bathrooms ? { min: min_bathrooms, max: max_bathrooms } : null,
        sqft_range: min_sqft || max_sqft ? { min: min_sqft, max: max_sqft } : null,
        landlord_verified,
        near: lat !== undefined && lng !== undefined ? { lat, lng } : null,
        sort_by
      }
    });

  } catch (error) {
    console.error('Error searching properties:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to search properties'
    });
  }
});

// POST /admin/geocode-properties - Backfill geocoding for properties without coordinates
app.post('/admin/geocode-properties', requireAdminSecret, async (req, res) => {
  try {
    const adminSecret = req.headers['admin-secret'] || req.body.admin_secret;
    
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Invalid or missing admin_secret'
      });
    }

    // Get properties missing coordinates, a Street View heading, or (for
    // properties that already have a heading from before panorama
    // coordinates were tracked) the panorama's own lat/lng -- those older
    // rows still point their Static/Embed image requests at the raw
    // property coordinates instead of the confirmed panorama, which is
    // exactly the mismatch that could silently render as "no imagery".
    // (limit 100 per request)
    const query = `
      SELECT id, address, city, state, zip_code, latitude, longitude, street_view_heading, street_view_lat, street_view_lng
      FROM properties
      WHERE latitude IS NULL OR longitude IS NULL OR street_view_heading IS NULL
         OR (street_view_heading IS NOT NULL AND street_view_lat IS NULL)
      LIMIT 100
    `;

    const result = await pool.query(query);
    const properties = result.rows;

    let geocoded = 0;
    let failed = 0;

    for (const prop of properties) {
      try {
        let latitude = prop.latitude;
        let longitude = prop.longitude;

        // Only re-geocode (costs a Nominatim request) if coordinates are
        // actually missing — otherwise just fill in the heading.
        if (latitude == null || longitude == null) {
          const geocodeResult = await geocodeAddress(prop.address, prop.city, prop.state, prop.zip_code);
          if (geocodeResult.success) {
            latitude = geocodeResult.latitude;
            longitude = geocodeResult.longitude;
          }
          await delay(1100); // Respect Nominatim's 1 req/sec rate limit
        }

        if (latitude == null || longitude == null) {
          failed++;
          continue;
        }

        const streetView = await getStreetViewHeading(latitude, longitude);
        const heading = streetView?.heading ?? null;
        const streetViewLat = streetView?.lat ?? null;
        const streetViewLng = streetView?.lng ?? null;

        await pool.query(
          'UPDATE properties SET latitude = $1, longitude = $2, street_view_heading = $3, street_view_lat = $4, street_view_lng = $5 WHERE id = $6',
          [latitude, longitude, heading, streetViewLat, streetViewLng, prop.id]
        );
        geocoded++;
      } catch (error) {
        console.error(`Failed to geocode property ${prop.id}:`, error);
        failed++;
      }
    }

    // Count remaining properties still missing coordinates, a heading, or panorama coords
    const remainingResult = await pool.query(`
      SELECT COUNT(*) as count
      FROM properties
      WHERE latitude IS NULL OR longitude IS NULL OR street_view_heading IS NULL
         OR (street_view_heading IS NOT NULL AND street_view_lat IS NULL)
    `);
    const remaining = parseInt(remainingResult.rows[0].count);

    res.json({
      success: true,
      message: 'Geocoding backfill complete',
      geocoded,
      failed,
      processed: properties.length,
      remaining,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Geocoding backfill error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Geocoding backfill failed',
      details: error.message
    });
  }
});

// POST /admin/normalize-states - One-time backfill for properties saved
// before state values were normalized to 2-letter codes. Community-submitted
// properties in particular could have picked up a full state name (e.g.
// "New Jersey") from Nominatim's geocoding response, which search's
// substring matching would never match against someone searching "NJ".
app.post('/admin/normalize-states', requireAdminSecret, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, state FROM properties');

    let updated = 0;
    for (const prop of result.rows) {
      const normalized = normalizeState(prop.state);
      if (normalized !== prop.state) {
        await pool.query('UPDATE properties SET state = $1 WHERE id = $2', [normalized, prop.id]);
        updated++;
      }
    }

    res.json({
      success: true,
      message: 'State normalization complete',
      checked: result.rows.length,
      updated,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('State normalization error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'State normalization failed',
      details: error.message
    });
  }
});

// GET /properties/stats - Get property statistics (bonus endpoint)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏠 Property service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

