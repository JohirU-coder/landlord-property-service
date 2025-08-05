require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const Joi = require('joi');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3002;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Validation schema for property creation
const createPropertySchema = Joi.object({
  address: Joi.string().required().min(5).max(500),
  city: Joi.string().required().min(2).max(100),
  state: Joi.string().required().min(2).max(50),
  zip_code: Joi.string().required().pattern(/^\d{5}(-\d{4})?$/), // US zip code format
  rent_amount: Joi.number().positive().precision(2).max(50000), // Max $50k rent
  bedrooms: Joi.number().integer().min(0).max(20),
  bathrooms: Joi.number().positive().precision(1).max(20),
  square_feet: Joi.number().integer().positive().max(50000),
  description: Joi.string().max(2000),
  landlord_id: Joi.number().integer().required()
});

app.use(helmet());
app.use(cors());
app.use(express.json());

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

app.get('/setup-database', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS properties (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        city VARCHAR(100) NOT NULL,
        state VARCHAR(50) NOT NULL,
        zip_code VARCHAR(20) NOT NULL,
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

// POST /properties - Create a new property
app.post('/properties', async (req, res) => {
  try {
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
      state,
      zip_code,
      rent_amount,
      bedrooms,
      bathrooms,
      square_feet,
      description,
      landlord_id
    } = value;

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

    // Insert the new property
    const insertQuery = `
      INSERT INTO properties (
        address, city, state, zip_code, rent_amount, 
        bedrooms, bathrooms, square_feet, description, landlord_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;

    const result = await pool.query(insertQuery, [
      address,
      city,
      state,
      zip_code,
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
      JOIN users u ON p.landlord_id = u.id
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
  city: Joi.string().min(2).max(100),
  state: Joi.string().min(2).max(50),
  zip_code: Joi.string().pattern(/^\d{5}(-\d{4})?$/),
  min_rent: Joi.number().positive().max(50000),
  max_rent: Joi.number().positive().max(50000).greater(Joi.ref('min_rent')),
  min_bedrooms: Joi.number().integer().min(0).max(20),
  max_bedrooms: Joi.number().integer().min(0).max(20).min(Joi.ref('min_bedrooms')),
  min_bathrooms: Joi.number().positive().precision(1).max(20),
  max_bathrooms: Joi.number().positive().precision(1).max(20).min(Joi.ref('min_bathrooms')),
  min_sqft: Joi.number().integer().positive().max(50000),
  max_sqft: Joi.number().integer().positive().max(50000).min(Joi.ref('min_sqft')),
  landlord_verified: Joi.boolean(),
  sort_by: Joi.string().valid('rent_asc', 'rent_desc', 'newest', 'oldest', 'sqft_asc', 'sqft_desc'),
  limit: Joi.number().integer().min(1).max(100).default(20),
  offset: Joi.number().integer().min(0).default(0)
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
      sort_by = 'newest',
      limit = 20,
      offset = 0
    } = value;

    // Build dynamic WHERE clause
    let whereConditions = [];
    let queryParams = [];
    let paramCount = 0;

    // Add filters based on provided parameters
    if (city) {
      paramCount++;
      whereConditions.push(`LOWER(p.city) LIKE LOWER($${paramCount})`);
      queryParams.push(`%${city}%`);
    }

    if (state) {
      paramCount++;
      whereConditions.push(`LOWER(p.state) = LOWER($${paramCount})`);
      queryParams.push(state);
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

    // Build WHERE clause
    const whereClause = whereConditions.length > 0 
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Build ORDER BY clause
    let orderClause;
    switch (sort_by) {
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
        p.rent_amount,
        p.bedrooms,
        p.bathrooms,
        p.square_feet,
        p.description,
        p.landlord_verified,
        p.created_at,
        u.first_name as landlord_first_name,
        u.last_name as landlord_last_name,
        u.email as landlord_email
      FROM properties p
      JOIN users u ON p.landlord_id = u.id
      ${whereClause}
      ${orderClause}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    // Count query for pagination metadata
    const countQuery = `
      SELECT COUNT(*) as total
      FROM properties p
      JOIN users u ON p.landlord_id = u.id
      ${whereClause}
    `;

    // Execute both queries
    const [searchResult, countResult] = await Promise.all([
      pool.query(searchQuery, queryParams),
      pool.query(countQuery, queryParams.slice(0, -2)) // Remove limit and offset for count
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
      rent_amount: property.rent_amount,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      square_feet: property.square_feet,
      description: property.description,
      landlord_verified: property.landlord_verified,
      created_at: property.created_at,
      landlord: {
        first_name: property.landlord_first_name,
        last_name: property.landlord_last_name,
        email: property.landlord_email
      }
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
        city,
        state,
        zip_code,
        rent_range: min_rent || max_rent ? { min: min_rent, max: max_rent } : null,
        bedrooms_range: min_bedrooms !== undefined || max_bedrooms !== undefined ? { min: min_bedrooms, max: max_bedrooms } : null,
        bathrooms_range: min_bathrooms || max_bathrooms ? { min: min_bathrooms, max: max_bathrooms } : null,
        sqft_range: min_sqft || max_sqft ? { min: min_sqft, max: max_sqft } : null,
        landlord_verified,
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

// GET /properties/stats - Get property statistics (bonus endpoint)
app.get('/properties/stats', async (req, res) => {
  try {
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
      WHERE rent_amount IS NOT NULL
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏠 Property service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});