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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏠 Property service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

const createPropertySchema = Joi.object({

app.post('/properties', async (req, res) => {

app.get('/properties/:id', async (req, res) => {
});