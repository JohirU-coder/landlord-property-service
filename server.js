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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏠 Property service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});