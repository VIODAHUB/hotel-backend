const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors({ origin: '*' }));

// ============================================================
//  DATABASE CONNECTION (Supabase)
// ============================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Test connection on startup
pool.connect((err) => {
    if (err) {
        console.error('❌ Database connection error:', err);
        console.error('   Please check your DATABASE_URL environment variable');
        process.exit(1);
    } else {
        console.log('✅ Connected to Supabase PostgreSQL');
    }
});

// ============================================================
//  DATABASE SCHEMA CREATION
// ============================================================

async function createTables() {
    const client = await pool.connect();
    try {
        console.log('📦 Creating database tables if they don\'t exist...');
        
        // Create users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                user_type VARCHAR(50) NOT NULL,
                company_name VARCHAR(255),
                full_name VARCHAR(255),
                is_verified BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Users table ready');

        // Create hotels table
        await client.query(`
            CREATE TABLE IF NOT EXISTS hotels (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                hotel_name VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                city VARCHAR(100),
                country VARCHAR(100),
                address TEXT,
                description TEXT,
                star_rating INTEGER DEFAULT 3,
                is_active BOOLEAN DEFAULT TRUE,
                is_featured BOOLEAN DEFAULT FALSE,
                photos TEXT[] DEFAULT '{}',
                meals JSONB DEFAULT '[]',
                drinks JSONB DEFAULT '[]',
                whats_new TEXT DEFAULT '',
                subscription_expiry TIMESTAMP,
                subscription_paid_date TIMESTAMP,
                subscription_payment_confirmation VARCHAR(255),
                subscription_payment_verified BOOLEAN DEFAULT FALSE,
                subscription_payment_verified_at TIMESTAMP,
                featured_expiry TIMESTAMP,
                featured_paid_date TIMESTAMP,
                featured_payment_confirmation VARCHAR(255),
                featured_payment_verified BOOLEAN DEFAULT FALSE,
                featured_payment_verified_at TIMESTAMP,
                payment_method VARCHAR(50) DEFAULT 'mpesa',
                paybill_number VARCHAR(50),
                till_number VARCHAR(50),
                account_number_format VARCHAR(100),
                payment_instructions TEXT,
                payment_verification_enabled BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Hotels table ready');

        // Create rooms table
        await client.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id SERIAL PRIMARY KEY,
                hotel_id INTEGER REFERENCES hotels(id) ON DELETE CASCADE,
                room_type_name VARCHAR(255) NOT NULL,
                capacity INTEGER NOT NULL,
                base_price_per_night DECIMAL(10,2) NOT NULL,
                total_rooms INTEGER DEFAULT 1,
                is_available BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Rooms table ready');

        // Create conference_rooms table
        await client.query(`
            CREATE TABLE IF NOT EXISTS conference_rooms (
                id SERIAL PRIMARY KEY,
                hotel_id INTEGER REFERENCES hotels(id) ON DELETE CASCADE,
                room_name VARCHAR(255) NOT NULL,
                capacity INTEGER NOT NULL,
                price_per_hour DECIMAL(10,2) NOT NULL,
                amenities TEXT[] DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Conference rooms table ready');

        // Create hotel_menu table
        await client.query(`
            CREATE TABLE IF NOT EXISTS hotel_menu (
                id SERIAL PRIMARY KEY,
                hotel_id INTEGER REFERENCES hotels(id) ON DELETE CASCADE,
                item_name VARCHAR(255) NOT NULL,
                description TEXT,
                price DECIMAL(10,2) NOT NULL,
                category VARCHAR(100) DEFAULT 'main',
                is_available BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Hotel menu table ready');

        // Create room_bookings table
        await client.query(`
            CREATE TABLE IF NOT EXISTS room_bookings (
                id SERIAL PRIMARY KEY,
                client_id INTEGER REFERENCES users(id),
                hotel_id INTEGER REFERENCES hotels(id) ON DELETE CASCADE,
                room_type_id INTEGER REFERENCES rooms(id),
                client_name VARCHAR(255),
                client_phone VARCHAR(50),
                check_in_date DATE NOT NULL,
                check_out_date DATE NOT NULL,
                number_of_guests INTEGER DEFAULT 1,
                total_amount DECIMAL(10,2) NOT NULL,
                special_requests TEXT,
                payment_status VARCHAR(50) DEFAULT 'pending',
                payment_method VARCHAR(50),
                payment_reference VARCHAR(255),
                payment_verified BOOLEAN DEFAULT FALSE,
                payment_confirmation_code VARCHAR(255),
                payment_verified_at TIMESTAMP,
                booking_reference VARCHAR(255) UNIQUE,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Room bookings table ready');

        // Create food_orders table
        await client.query(`
            CREATE TABLE IF NOT EXISTS food_orders (
                id SERIAL PRIMARY KEY,
                client_id INTEGER REFERENCES users(id),
                hotel_id INTEGER REFERENCES hotels(id) ON DELETE CASCADE,
                client_name VARCHAR(255),
                client_phone VARCHAR(50),
                items JSONB NOT NULL,
                total_amount DECIMAL(10,2) NOT NULL,
                pickup_date DATE NOT NULL,
                pickup_time TIME,
                special_instructions TEXT,
                payment_status VARCHAR(50) DEFAULT 'pending',
                payment_method VARCHAR(50),
                payment_reference VARCHAR(255),
                payment_verified BOOLEAN DEFAULT FALSE,
                payment_confirmation_code VARCHAR(255),
                payment_verified_at TIMESTAMP,
                booking_reference VARCHAR(255) UNIQUE,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Food orders table ready');

        // Create payments table
        await client.query(`
            CREATE TABLE IF NOT EXISTS payments (
                id SERIAL PRIMARY KEY,
                client_id INTEGER REFERENCES users(id),
                hotel_id INTEGER REFERENCES hotels(id) ON DELETE CASCADE,
                paid BOOLEAN DEFAULT FALSE,
                session_id VARCHAR(255),
                transaction_id VARCHAR(255),
                amount DECIMAL(10,2),
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Payments table ready');

        // Create pending_payments table
        await client.query(`
            CREATE TABLE IF NOT EXISTS pending_payments (
                id SERIAL PRIMARY KEY,
                client_id INTEGER REFERENCES users(id),
                hotel_id INTEGER REFERENCES hotels(id) ON DELETE CASCADE,
                amount DECIMAL(10,2),
                reference VARCHAR(255),
                transaction_id VARCHAR(255),
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Pending payments table ready');

        // Create reviews table
        await client.query(`
            CREATE TABLE IF NOT EXISTS reviews (
                id SERIAL PRIMARY KEY,
                hotel_id INTEGER REFERENCES hotels(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id),
                user_name VARCHAR(255),
                rating INTEGER CHECK (rating >= 1 AND rating <= 5),
                comment TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Reviews table ready');

        console.log('✅ All database tables are ready!');
        
    } catch (error) {
        console.error('❌ Error creating tables:', error);
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================
//  ENSURE ADMIN USER EXISTS
// ============================================================

async function ensureAdminUser() {
    try {
        const adminEmail = 'admin@hotelbooking.com';
        const adminPassword = 'admin123';
        const hashedPassword = await bcrypt.hash(adminPassword, 10);
        
        // Check if admin exists
        const check = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [adminEmail]
        );
        
        if (check.rows.length === 0) {
            await pool.query(
                `INSERT INTO users (email, password_hash, user_type, full_name, is_verified)
                 VALUES ($1, $2, 'admin', 'Super Admin', TRUE)`,
                [adminEmail, hashedPassword]
            );
            console.log('✅ Admin user created');
        } else {
            console.log('✅ Admin user already exists');
        }
    } catch (error) {
        console.error('❌ Error ensuring admin user:', error);
    }
}

// ============================================================
//  HOTBOOK PAYMENT CONFIGURATION
// ============================================================

const HOTBOOK_PAYMENT = {
    TILL_NUMBER: process.env.HOTBOOK_TILL_NUMBER || '9948409',
    BUSINESS_NAME: process.env.HOTBOOK_BUSINESS_NAME || 'VIODA ENTERPRISES',
    PAYMENT_INSTRUCTIONS: `📱 M-Pesa Payment Instructions:
1. Go to M-Pesa > Lipa Na M-Pesa > Till Number
2. Enter Till Number: 9948409
3. Enter Account Number: [Your Hotel ID + Reference]
4. Enter Amount: 
   - KES 1,000 for Basic Subscription (30 days)
   - KES 5,000 for Featured Subscription (30 days)
5. Enter your M-Pesa PIN
6. You will receive a confirmation message with a code`
};

console.log('='.repeat(50));
console.log('📋 HOTBOOK PAYMENT CONFIGURATION:');
console.log('   Till Number:', HOTBOOK_PAYMENT.TILL_NUMBER);
console.log('   Business:', HOTBOOK_PAYMENT.BUSINESS_NAME);
console.log('='.repeat(50));

// ============================================================
//  TUMA PAYMENT CONFIGURATION
// ============================================================

const TUMA_CONFIG = {
    API_URL: process.env.TUMA_API_URL || 'https://api.tuma.co.ke',
    EMAIL: process.env.TUMA_EMAIL,
    API_KEY: process.env.TUMA_API_KEY,
    CALLBACK_URL: process.env.TUMA_CALLBACK_URL || 'https://hotel-backend-s79n.onrender.com/api/payment-callback',
    TIMEOUT: 30000,
    ENABLED: process.env.TUMA_ENABLED === 'true'
};

console.log('📋 TUMA CONFIGURATION:');
console.log('   Enabled:', TUMA_CONFIG.ENABLED ? '✅ Yes' : '❌ No');

// ============================================================
//  TUMA API FUNCTIONS (Simplified to avoid fetch issues)
// ============================================================

async function getTumaToken() {
    if (!TUMA_CONFIG.ENABLED || !TUMA_CONFIG.EMAIL || !TUMA_CONFIG.API_KEY) {
        throw new Error('Tuma payments are disabled.');
    }
    
    try {
        // Using fetch which is available in Node.js v18+
        const response = await fetch(`${TUMA_CONFIG.API_URL}/auth/token`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                email: TUMA_CONFIG.EMAIL,
                api_key: TUMA_CONFIG.API_KEY
            })
        });
        
        const responseText = await response.text();
        if (!response.ok) {
            throw new Error(`Tuma auth failed: ${response.status}`);
        }
        
        const data = JSON.parse(responseText);
        const token = data.token || data.access_token || data.data?.token;
        if (!token) {
            throw new Error('No token received from Tuma');
        }
        return token;
    } catch (error) {
        console.error('❌ Tuma token error:', error.message);
        throw error;
    }
}

async function initiateTumaPayment(phone, amount, description, reference) {
    if (!TUMA_CONFIG.ENABLED) {
        throw new Error('Tuma payments are disabled.');
    }
    
    try {
        const token = await getTumaToken();
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        let formattedPhone;
        if (cleanPhone.startsWith('0')) {
            formattedPhone = '254' + cleanPhone.slice(1);
        } else if (cleanPhone.startsWith('254')) {
            formattedPhone = cleanPhone;
        } else {
            formattedPhone = '254' + cleanPhone;
        }
        
        const payload = {
            amount: amount,
            phone: formattedPhone,
            callback_url: TUMA_CONFIG.CALLBACK_URL,
            description: description || 'HotBook Payment'
        };
        
        const response = await fetch(`${TUMA_CONFIG.API_URL}/payment/stk-push`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        
        const responseText = await response.text();
        if (!response.ok) {
            throw new Error(`Payment request failed: ${response.status}`);
        }
        
        const result = JSON.parse(responseText);
        const transactionId = result.transaction_id || result.data?.transaction_id || 'pending';
        
        return {
            success: true,
            transaction_id: transactionId,
            raw_response: result
        };
    } catch (error) {
        console.error('❌ Tuma payment error:', error.message);
        throw error;
    }
}

async function checkTumaPaymentStatus(transactionId) {
    if (!TUMA_CONFIG.ENABLED) {
        return { status: 'pending', paid: false };
    }
    
    try {
        const token = await getTumaToken();
        const response = await fetch(`${TUMA_CONFIG.API_URL}/payment/status/${transactionId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            return { status: 'pending', paid: false };
        }
        
        const result = await response.json();
        const status = result.status || result.data?.status || 'pending';
        return {
            status: status,
            paid: status === 'completed' || status === 'paid' || status === 'success',
            ...result
        };
    } catch (error) {
        console.error('❌ Tuma status check error:', error.message);
        return { status: 'pending', paid: false };
    }
}

// ============================================================
//  MIDDLEWARE
// ============================================================

const isAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        if (decoded.userType !== 'admin') {
            return res.status(403).json({ error: 'Admin only' });
        }
        req.userId = decoded.id;
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
};

const isHotelOwner = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        if (decoded.userType !== 'hotel') {
            return res.status(403).json({ error: 'Hotel owner only' });
        }
        req.userId = decoded.id;
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// ============================================================
//  AUTH ROUTES
// ============================================================

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign(
            { id: user.id, userType: user.user_type, email: user.email },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '30d' }
        );
        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                userType: user.user_type,
                full_name: user.full_name
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error: ' + error.message });
    }
});

app.post('/api/auth/register', async (req, res) => {
    const { email, password, userType, companyName, fullName } = req.body;
    try {
        const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (exists.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (email, password_hash, user_type, company_name, full_name, is_verified)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             RETURNING id, email, user_type, full_name`,
            [email, hashedPassword, userType, companyName || null, fullName || null]
        );

        const user = result.rows[0];
        const token = jwt.sign(
            { id: user.id, userType: user.user_type, email: user.email },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '30d' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                userType: user.user_type,
                full_name: user.full_name
            }
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Server error: ' + error.message });
    }
});

// ============================================================
//  START SERVER
// ============================================================

async function startServer() {
    try {
        // First, test database connection
        await pool.query('SELECT NOW()');
        console.log('✅ Supabase database connected successfully');
        
        // Create all tables if they don't exist
        await createTables();
        
        // Ensure admin user exists
        await ensureAdminUser();
        
        // Start the server
        app.listen(port, '0.0.0.0', () => {
            console.log('\n' + '='.repeat(50));
            console.log('🚀 SERVER STARTED SUCCESSFULLY!');
            console.log(`   Port: ${port}`);
            console.log(`   Admin: admin@hotelbooking.com / admin123`);
            console.log(`   HotBook Till: ${HOTBOOK_PAYMENT.TILL_NUMBER} (${HOTBOOK_PAYMENT.BUSINESS_NAME})`);
            console.log(`   Tuma Payments: ${TUMA_CONFIG.ENABLED ? '✅ Enabled' : '❌ Disabled'}`);
            console.log('='.repeat(50));
        });
        
    } catch (error) {
        console.error('❌ Failed to start server:', error.message);
        console.error('   Make sure DATABASE_URL environment variable is set correctly');
        process.exit(1);
    }
}

// Start the server
startServer();

// Handle uncaught errors to prevent crashing
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});
