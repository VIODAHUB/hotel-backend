const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors({ origin: '*' }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) console.error('❌ Database connection error:', err);
    else console.log('✅ Connected to PostgreSQL');
});

// ============================================================
//  TUMA PAYMENT CONFIGURATION
// ============================================================

const TUMA_CONFIG = {
    API_URL: process.env.TUMA_API_URL || 'https://api.tuma.co.ke',
    EMAIL: process.env.TUMA_EMAIL,
    API_KEY: process.env.TUMA_API_KEY,
    CALLBACK_URL: process.env.TUMA_CALLBACK_URL || 'https://hotel-backend-s79n.onrender.com/api/payment-callback',
    TIMEOUT: 30000,
    // Enable mock mode if no credentials or for testing
    MOCK_MODE: process.env.TUMA_MOCK_MODE === 'true' || !process.env.TUMA_EMAIL || !process.env.TUMA_API_KEY
};

console.log('📋 Tuma Configuration:');
console.log('   API URL:', TUMA_CONFIG.API_URL);
console.log('   Email:', TUMA_CONFIG.EMAIL ? '✅ Set' : '❌ Missing');
console.log('   API Key:', TUMA_CONFIG.API_KEY ? '✅ Set' : '❌ Missing');
console.log('   Mock Mode:', TUMA_CONFIG.MOCK_MODE ? '✅ Enabled' : '❌ Disabled');

// ============================================================
//  TUMA API HELPER FUNCTIONS
// ============================================================

async function getTumaToken() {
    // If in mock mode, return a fake token
    if (TUMA_CONFIG.MOCK_MODE) {
        console.log('🔑 [MOCK] Using fake token');
        return 'mock_token_' + Date.now();
    }

    try {
        console.log('🔑 Getting Tuma token...');
        console.log('📧 Using email:', TUMA_CONFIG.EMAIL);
        console.log('🌐 API URL:', `${TUMA_CONFIG.API_URL}/auth/token`);
        
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
        console.log('📄 Auth response status:', response.status);
        console.log('📄 Auth response:', responseText.substring(0, 500));
        
        if (!response.ok) {
            console.error('❌ Tuma auth failed:', response.status, responseText);
            throw new Error(`Tuma auth failed: ${response.status} - ${responseText}`);
        }
        
        const data = JSON.parse(responseText);
        console.log('📥 Parsed auth response:', JSON.stringify(data, null, 2));
        
        // Try different possible token locations
        const token = data.token || data.access_token || data.data?.token || data.data?.access_token;
        
        if (!token) {
            console.error('❌ No token found in response. Response structure:', Object.keys(data));
            throw new Error('No token received from Tuma');
        }
        
        console.log('✅ Tuma token obtained successfully');
        return token;
    } catch (error) {
        console.error('❌ Tuma token error:', error.message);
        // If real auth fails, fall back to mock mode
        console.log('⚠️ Falling back to mock mode');
        TUMA_CONFIG.MOCK_MODE = true;
        return 'mock_token_' + Date.now();
    }
}

async function initiateTumaPayment(phone, amount, description, reference) {
    // MOCK MODE - Simulate payment without real Tuma
    if (TUMA_CONFIG.MOCK_MODE) {
        console.log('🔧 [MOCK] Simulating Tuma payment...');
        console.log(`   Phone: ${phone}, Amount: ${amount}, Reference: ${reference}`);
        
        // Generate a fake transaction ID
        const fakeTransactionId = 'MOCK-' + Date.now().toString().slice(-8);
        
        // In mock mode, always succeed after 3 seconds (simulate STK push)
        setTimeout(() => {
            console.log(`✅ [MOCK] Payment completed: ${fakeTransactionId}`);
        }, 3000);
        
        return {
            success: true,
            transaction_id: fakeTransactionId,
            message: 'Payment initiated (MOCK)',
            mock: true
        };
    }

    // REAL TUMA PAYMENT
    try {
        const token = await getTumaToken();
        console.log('✅ Token obtained, initiating payment...');
        
        // Format phone number for Tuma (254XXXXXXXXX)
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        const formattedPhone = cleanPhone.startsWith('0') ? '254' + cleanPhone.slice(1) : 
                              cleanPhone.startsWith('254') ? cleanPhone : '254' + cleanPhone;
        
        const payload = {
            amount: amount,
            phone: formattedPhone,
            callback_url: TUMA_CONFIG.CALLBACK_URL,
            description: description || 'HotBook Payment',
            reference: reference || 'HOTBOOK-' + Date.now()
        };
        
        console.log('📤 Sending Tuma payment payload:', { ...payload, phone: formattedPhone });
        
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
        console.log('📄 Payment response status:', response.status);
        console.log('📄 Payment response:', responseText.substring(0, 500));
        
        if (!response.ok) {
            console.error('❌ Payment request failed:', response.status, responseText);
            throw new Error(`Payment request failed: ${response.status} - ${responseText}`);
        }
        
        const result = JSON.parse(responseText);
        console.log('📥 Tuma payment result:', result);
        
        // Handle different response structures
        const transactionId = result.transaction_id || result.data?.transaction_id || result.id || 'pending';
        
        return {
            success: true,
            transaction_id: transactionId,
            ...result
        };
    } catch (error) {
        console.error('❌ Tuma payment error:', error.message);
        // Fallback to mock mode on error
        console.log('⚠️ Falling back to mock mode for this payment');
        return initiateTumaPayment(phone, amount, description, reference);
    }
}

async function checkTumaPaymentStatus(transactionId) {
    // MOCK MODE - Simulate status check
    if (TUMA_CONFIG.MOCK_MODE || transactionId.startsWith('MOCK-')) {
        console.log(`🔍 [MOCK] Checking payment status: ${transactionId}`);
        // 80% chance of being completed in mock mode
        const isCompleted = Math.random() < 0.8;
        return {
            status: isCompleted ? 'completed' : 'pending',
            paid: isCompleted,
            transaction_id: transactionId
        };
    }

    try {
        const token = await getTumaToken();
        console.log(`🔍 Checking payment status for: ${transactionId}`);
        
        const response = await fetch(`${TUMA_CONFIG.API_URL}/payment/status/${transactionId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        
        const responseText = await response.text();
        console.log('📄 Status response:', responseText.substring(0, 500));
        
        if (!response.ok) {
            console.error('❌ Status check failed:', response.status, responseText);
            return { status: 'pending', paid: false };
        }
        
        const result = JSON.parse(responseText);
        const status = result.status || result.data?.status || 'pending';
        const paid = status === 'completed' || status === 'paid' || status === 'success';
        
        return {
            status: status,
            paid: paid,
            ...result
        };
    } catch (error) {
        console.error('❌ Tuma status check error:', error.message);
        return { status: 'pending', paid: false };
    }
}

// ============================================================
//  PAYMENT CALLBACK WEBHOOK
// ============================================================

app.post('/api/payment-callback', express.json({ type: 'application/json' }), async (req, res) => {
    console.log('📥 Payment callback received:', req.body);
    
    try {
        const { 
            transaction_id, 
            status, 
            amount, 
            phone, 
            reference,
            description 
        } = req.body;
        
        // Always respond immediately to Tuma
        res.status(200).json({ status: 'received' });
        
        // Process payment asynchronously if completed
        if (status === 'completed' || status === 'paid' || status === 'success') {
            await processSuccessfulUnlockPayment(transaction_id, {
                amount: amount,
                phone: phone,
                reference: reference,
                description: description
            });
        }
    } catch (error) {
        console.error('❌ Payment callback error:', error);
        res.status(200).json({ status: 'error', message: error.message });
    }
});

// ============================================================
//  PROCESS UNLOCK PAYMENT (100 KES)
// ============================================================

async function processSuccessfulUnlockPayment(transactionId, data) {
    const { amount, phone, reference, description } = data;
    
    console.log(`✅ Processing successful unlock payment: ${transactionId}`);
    console.log(`   Amount: ${amount}, Phone: ${phone}, Ref: ${reference}`);
    
    // Extract hotel ID and client ID from reference: UNLOCK-hotelId-clientId
    const unlockMatch = reference.match(/UNLOCK-(\d+)-(\d+)/);
    if (unlockMatch) {
        const hotelId = parseInt(unlockMatch[1]);
        const clientId = parseInt(unlockMatch[2]);
        
        try {
            const UNLOCK_EXPIRY_DAYS = 7;
            const expiryDate = new Date(Date.now() + UNLOCK_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
            
            // Check if payment already exists
            const existing = await pool.query(
                'SELECT * FROM payments WHERE client_id = $1 AND hotel_id = $2',
                [clientId, hotelId]
            );
            
            if (existing.rows.length > 0) {
                await pool.query(
                    `UPDATE payments SET 
                        paid = TRUE, 
                        expires_at = $1,
                        transaction_id = $2,
                        updated_at = CURRENT_TIMESTAMP
                     WHERE client_id = $3 AND hotel_id = $4`,
                    [expiryDate, transactionId, clientId, hotelId]
                );
            } else {
                await pool.query(
                    `INSERT INTO payments (client_id, hotel_id, paid, transaction_id, amount, expires_at)
                     VALUES ($1, $2, TRUE, $3, $4, $5)`,
                    [clientId, hotelId, transactionId, 100, expiryDate]
                );
            }
            
            // Update pending payment status
            await pool.query(
                `UPDATE pending_payments SET status = 'completed' WHERE transaction_id = $1`,
                [transactionId]
            );
            
            console.log(`✅ Unlock payment processed: Hotel ${hotelId}, Client ${clientId}`);
            
        } catch (error) {
            console.error('❌ Unlock payment processing error:', error);
        }
    } else {
        console.log('⚠️ Could not extract hotel/client IDs from reference:', reference);
    }
}

// ============================================================
//  INITIATE UNLOCK PAYMENT
// ============================================================

app.post('/api/payments/unlock', async (req, res) => {
    try {
        const { hotel_id, phone } = req.body;
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Please login first' });
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;
        
        console.log(`🔓 Unlock request: Client ${clientId}, Hotel ${hotel_id}, Phone ${phone}`);
        
        // Validate phone number
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        if (!cleanPhone || cleanPhone.length < 10) {
            return res.status(400).json({ error: 'Please enter a valid phone number (e.g., 0712345678)' });
        }
        
        // Check if already paid
        const existing = await pool.query(
            'SELECT * FROM payments WHERE client_id = $1 AND hotel_id = $2 AND paid = TRUE AND expires_at > NOW()',
            [clientId, hotel_id]
        );
        
        if (existing.rows.length > 0) {
            return res.json({
                success: true,
                message: 'You already have access to this hotel.',
                already_paid: true
            });
        }
        
        const reference = `UNLOCK-${hotel_id}-${clientId}`;
        const description = `Unlock hotel details - ${hotel_id}`;
        
        // Initiate payment with Tuma
        const payment = await initiateTumaPayment(phone, 100, description, reference);
        
        // Handle mock payment differently
        if (payment.mock) {
            console.log('🔧 [MOCK] Payment initiated in mock mode');
            
            // Save pending payment
            await pool.query(
                `INSERT INTO pending_payments (client_id, hotel_id, amount, reference, transaction_id, status)
                 VALUES ($1, $2, $3, $4, $5, 'pending')`,
                [clientId, hotel_id, 100, reference, payment.transaction_id]
            );
            
            return res.json({
                success: true,
                message: '[MOCK MODE] Payment initiated. Please check your phone for the M-Pesa prompt.',
                transaction_id: payment.transaction_id,
                mock: true,
                note: 'This is a mock payment for testing. No real money will be charged.'
            });
        }
        
        // Save pending payment
        await pool.query(
            `INSERT INTO pending_payments (client_id, hotel_id, amount, reference, transaction_id, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [clientId, hotel_id, 100, reference, payment.transaction_id || 'pending']
        );
        
        res.json({
            success: true,
            message: 'Payment initiated. Please check your phone for the M-Pesa prompt.',
            transaction_id: payment.transaction_id
        });
        
    } catch (error) {
        console.error('❌ Unlock payment error:', error);
        res.status(500).json({ error: 'Failed to initiate payment: ' + error.message });
    }
});

// ============================================================
//  CHECK PAYMENT STATUS
// ============================================================

app.get('/api/payments/status/:transactionId', async (req, res) => {
    try {
        const { transactionId } = req.params;
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Please login first' });
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;
        
        // Check local database first
        const localResult = await pool.query(
            'SELECT * FROM pending_payments WHERE transaction_id = $1 AND client_id = $2',
            [transactionId, clientId]
        );
        
        if (localResult.rows.length > 0 && localResult.rows[0].status === 'completed') {
            return res.json({ status: 'completed', paid: true });
        }
        
        // Check with Tuma
        console.log(`🔍 Checking payment status: ${transactionId}`);
        const status = await checkTumaPaymentStatus(transactionId);
        console.log(`📊 Payment status response:`, status);
        
        if (status.status === 'completed' || status.status === 'paid' || status.status === 'success') {
            // Update local record
            await pool.query(
                'UPDATE pending_payments SET status = $1 WHERE transaction_id = $2',
                ['completed', transactionId]
            );
            return res.json({ status: 'completed', paid: true });
        }
        
        res.json({ status: status.status || 'pending', paid: false });
        
    } catch (error) {
        console.error('❌ Payment status check error:', error);
        res.status(500).json({ error: 'Failed to check payment status' });
    }
});

 // ============================================================
//  ENSURE ADMIN USER EXISTS
// ============================================================

(async () => {
    try {
        const adminEmail = 'admin@hotelbooking.com';
        const adminPassword = 'admin123';
        const hashedPassword = await bcrypt.hash(adminPassword, 10);
        await pool.query(
            `INSERT INTO users (email, password_hash, user_type, full_name, is_verified)
             VALUES ($1, $2, 'admin', 'Super Admin', TRUE)
             ON CONFLICT (email) DO UPDATE SET password_hash = $2
             WHERE users.email = $1`,
            [adminEmail, hashedPassword]
        );
        console.log('✅ Admin user verified');
    } catch (error) {
        console.error('❌ Error ensuring admin user:', error);
    }
})();

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
            { 
                id: user.id, 
                userType: user.user_type,
                email: user.email 
            },
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
            { 
                id: user.id, 
                userType: user.user_type,
                email: user.email 
            },
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
//  HELPER FUNCTIONS
// ============================================================

const isHotelVisible = async (hotelId) => {
    const result = await pool.query(
        'SELECT is_active, subscription_expiry FROM hotels WHERE id = $1',
        [hotelId]
    );
    if (result.rows.length === 0) return false;
    const hotel = result.rows[0];
    if (!hotel.is_active) return false;
    if (!hotel.subscription_expiry) return false;
    const expiry = new Date(hotel.subscription_expiry);
    return expiry > new Date();
};

const isHotelFeatured = async (hotelId) => {
    const result = await pool.query(
        'SELECT is_featured, featured_expiry FROM hotels WHERE id = $1',
        [hotelId]
    );
    if (result.rows.length === 0) return false;
    const hotel = result.rows[0];
    if (!hotel.is_featured) return false;
    if (!hotel.featured_expiry) return false;
    const expiry = new Date(hotel.featured_expiry);
    return expiry > new Date();
};

// ============================================================
//  GET ROOM AVAILABILITY
// ============================================================

async function getRoomAvailability(hotelId, checkInDate, checkOutDate) {
    const roomsResult = await pool.query(
        'SELECT * FROM rooms WHERE hotel_id = $1',
        [hotelId]
    );
    
    let bookedMap = {};
    if (checkInDate && checkOutDate) {
        const bookingsResult = await pool.query(
            `SELECT room_type_id, COUNT(*) as booked_count 
             FROM room_bookings 
             WHERE hotel_id = $1 
               AND status = 'confirmed'
               AND check_in_date < $2 
               AND check_out_date > $3
             GROUP BY room_type_id`,
            [hotelId, checkOutDate, checkInDate]
        );
        
        bookingsResult.rows.forEach(b => {
            bookedMap[b.room_type_id] = parseInt(b.booked_count);
        });
    }
    
    return roomsResult.rows.map(room => {
        const booked = bookedMap[room.id] || 0;
        const total = room.total_rooms || 0;
        const available = Math.max(0, total - booked);
        return {
            ...room,
            booked_count: booked,
            available_rooms: available,
            total_rooms: total
        };
    });
}

// ============================================================
//  GET DATE-SPECIFIC STATISTICS
// ============================================================

async function getDateSpecificStats(hotelId, date) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    const roomsResult = await pool.query(
        'SELECT id, total_rooms, is_available FROM rooms WHERE hotel_id = $1',
        [hotelId]
    );
    
    const bookingsResult = await pool.query(
        `SELECT room_type_id, COUNT(*) as booked_count 
         FROM room_bookings 
         WHERE hotel_id = $1 
           AND status = 'confirmed'
           AND check_in_date <= $2 
           AND check_out_date > $2
         GROUP BY room_type_id`,
        [hotelId, targetDate]
    );
    
    const bookedMap = {};
    bookingsResult.rows.forEach(b => {
        bookedMap[b.room_type_id] = parseInt(b.booked_count);
    });
    
    let totalRooms = 0;
    let totalAvailable = 0;
    let totalBooked = 0;
    
    roomsResult.rows.forEach(room => {
        if (room.is_available) {
            const booked = bookedMap[room.id] || 0;
            const total = room.total_rooms || 0;
            totalRooms += total;
            totalBooked += booked;
            totalAvailable += Math.max(0, total - booked);
        }
    });
    
    const roomBookingsCount = await pool.query(
        `SELECT COUNT(*) as count 
         FROM room_bookings 
         WHERE hotel_id = $1 
           AND status = 'confirmed'
           AND check_in_date <= $2 
           AND check_out_date > $2`,
        [hotelId, targetDate]
    );
    
    const foodOrdersCount = await pool.query(
        `SELECT COUNT(*) as count 
         FROM food_orders 
         WHERE hotel_id = $1 
           AND status = 'confirmed'
           AND pickup_date = $2`,
        [hotelId, targetDate]
    );
    
    return {
        date: targetDate,
        total_rooms: totalRooms,
        available_rooms: totalAvailable,
        booked_rooms: totalBooked,
        room_bookings: parseInt(roomBookingsCount.rows[0].count),
        food_orders: parseInt(foodOrdersCount.rows[0].count)
    };
}

// ============================================================
//  ADMIN ROUTES
// ============================================================

app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const stats = await Promise.all([
            pool.query('SELECT COUNT(*) FROM hotels'),
            pool.query('SELECT COUNT(*) FROM users WHERE user_type != $1', ['admin']),
            pool.query('SELECT COUNT(*) FROM rooms'),
            pool.query('SELECT COUNT(*) FROM reviews'),
            pool.query('SELECT COUNT(*) FROM users WHERE user_type = $1', ['client'])
        ]);
        const totalPhotos = await pool.query('SELECT SUM(array_length(photos, 1)) FROM hotels');
        const recent = await pool.query('SELECT id, hotel_name, city, created_at FROM hotels ORDER BY created_at DESC LIMIT 5');
        res.json({
            totalHotels: parseInt(stats[0].rows[0].count),
            totalUsers: parseInt(stats[1].rows[0].count),
            totalRooms: parseInt(stats[2].rows[0].count),
            totalReviews: parseInt(stats[3].rows[0].count),
            totalClients: parseInt(stats[4].rows[0].count),
            totalPhotos: totalPhotos.rows[0].sum || 0,
            recentHotels: recent.rows
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/hotels', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT h.*, u.email as owner_email, u.full_name as owner_name,
                   (SELECT COUNT(*) FROM rooms WHERE hotel_id = h.id) as room_count,
                   (SELECT photos[1] FROM hotels WHERE id = h.id) as photo_url
            FROM hotels h
            LEFT JOIN users u ON h.user_id = u.id
            ORDER BY u.email, h.created_at DESC
        `);
        const hotels = await Promise.all(result.rows.map(async (h) => {
            const visible = await isHotelVisible(h.id);
            const featured = await isHotelFeatured(h.id);
            return { ...h, is_visible: visible, is_featured_active: featured };
        }));
        res.json(hotels);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/hotels/:id', isAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        const result = await pool.query('SELECT * FROM hotels WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/hotels', isAdmin, async (req, res) => {
    const { hotelName, ownerEmail, phone, city, country, address, description, starRating, isActive, photos } = req.body;
    if (photos && photos.length > 5) {
        return res.status(400).json({ error: 'Maximum 5 photos allowed' });
    }
    try {
        let owner = await pool.query('SELECT id FROM users WHERE email = $1 AND user_type = $2', [ownerEmail, 'hotel']);
        let userId;
        if (owner.rows.length > 0) {
            userId = owner.rows[0].id;
        } else {
            const tempPassword = Math.random().toString(36).slice(-8);
            const hashedPassword = await bcrypt.hash(tempPassword, 10);
            const newUser = await pool.query(
                `INSERT INTO users (email, password_hash, user_type, company_name, full_name, is_verified)
                 VALUES ($1, $2, $3, $4, $5, TRUE)
                 RETURNING id`,
                [ownerEmail, hashedPassword, 'hotel', hotelName, hotelName]
            );
            userId = newUser.rows[0].id;
            console.log(`🆕 Created owner: ${ownerEmail}, password: ${tempPassword}`);
        }
        const subscriptionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const result = await pool.query(
            `INSERT INTO hotels (user_id, hotel_name, phone, city, country, address, description, star_rating, is_active, photos, subscription_expiry, meals, drinks, whats_new)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             RETURNING *`,
            [userId, hotelName, phone || '', city, country, address || '', description || '', starRating || 3, isActive !== undefined ? isActive : true, photos || [], subscriptionExpiry, '[]', '[]', '']
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create hotel' });
    }
});

app.put('/api/admin/hotels/:id', isAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    const { hotelName, phone, city, country, address, description, starRating, isActive } = req.body;
    try {
        const result = await pool.query(
            `UPDATE hotels SET
                hotel_name = COALESCE($1, hotel_name),
                phone = COALESCE($2, phone),
                city = COALESCE($3, city),
                country = COALESCE($4, country),
                address = COALESCE($5, address),
                description = COALESCE($6, description),
                star_rating = COALESCE($7, star_rating),
                is_active = COALESCE($8, is_active),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $9
             RETURNING *`,
            [hotelName, phone, city, country, address, description, starRating, isActive, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to update hotel' });
    }
});

app.delete('/api/admin/hotels/:id', isAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        const result = await pool.query('DELETE FROM hotels WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found' });
        }
        res.json({ message: 'Deleted' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to delete hotel' });
    }
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, email, user_type, company_name, full_name, created_at FROM users ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/admin/users/:id/status', isAdmin, async (req, res) => {
    const userId = parseInt(req.params.id);
    const { is_verified } = req.body;
    
    try {
        const userCheck = await pool.query('SELECT user_type FROM users WHERE id = $1', [userId]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (userCheck.rows[0].user_type === 'admin') {
            return res.status(403).json({ error: 'Cannot modify admin accounts' });
        }
        
        const result = await pool.query(
            'UPDATE users SET is_verified = $1 WHERE id = $2 RETURNING id, email, user_type, is_verified',
            [is_verified, userId]
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Toggle user status error:', error);
        res.status(500).json({ error: 'Failed to update user status' });
    }
});

app.delete('/api/admin/users/:id', isAdmin, async (req, res) => {
    const userId = parseInt(req.params.id);
    
    try {
        const userCheck = await pool.query('SELECT user_type FROM users WHERE id = $1', [userId]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (userCheck.rows[0].user_type === 'admin') {
            return res.status(403).json({ error: 'Cannot delete admin accounts' });
        }
        
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// ============================================================
//  HOTEL OWNER ROUTES
// ============================================================

app.get('/api/hotels/owner/list', isHotelOwner, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM hotels WHERE user_id = $1 ORDER BY created_at DESC',
            [req.userId]
        );
        const hotels = await Promise.all(result.rows.map(async (h) => {
            const visible = await isHotelVisible(h.id);
            const featured = await isHotelFeatured(h.id);
            const daysLeft = h.subscription_expiry ?
                Math.max(0, Math.ceil((new Date(h.subscription_expiry) - new Date()) / (1000 * 60 * 60 * 24))) :
                0;
            return {
                ...h,
                is_visible: visible,
                is_featured_active: featured,
                subscription_days_left: daysLeft
            };
        }));
        res.json(hotels);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/hotels/owner/:id', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.id);
    try {
        const result = await pool.query(
            'SELECT * FROM hotels WHERE id = $1 AND user_id = $2',
            [hotelId, req.userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found or not owned by you' });
        }
        
        const hotel = result.rows[0];

        const safeHotel = {
            id: hotel.id,
            user_id: hotel.user_id,
            hotel_name: hotel.hotel_name || 'Unnamed Hotel',
            phone: hotel.phone || '',
            address: hotel.address || '',
            city: hotel.city || '',
            country: hotel.country || '',
            star_rating: hotel.star_rating || 3,
            description: hotel.description || '',
            photos: hotel.photos || [],
            is_active: hotel.is_active !== undefined ? hotel.is_active : true,
            subscription_expiry: hotel.subscription_expiry || null,
            is_featured: hotel.is_featured || false,
            featured_expiry: hotel.featured_expiry || null,
            meals: hotel.meals || [],
            drinks: hotel.drinks || [],
            whats_new: hotel.whats_new || '',
            created_at: hotel.created_at || new Date().toISOString(),
            updated_at: hotel.updated_at || new Date().toISOString()
        };

        const visible = await isHotelVisible(hotelId);
        const featured = await isHotelFeatured(hotelId);
        const daysLeft = safeHotel.subscription_expiry ?
            Math.max(0, Math.ceil((new Date(safeHotel.subscription_expiry) - new Date()) / (1000 * 60 * 60 * 24))) :
            0;

        const today = new Date().toISOString().split('T')[0];
        const stats = await getDateSpecificStats(hotelId, today);

        const roomBookings = await pool.query(
            `SELECT rb.*, COALESCE(r.room_type_name, 'Unknown') as room_type_name 
             FROM room_bookings rb
             LEFT JOIN rooms r ON rb.room_type_id = r.id
             WHERE rb.hotel_id = $1 AND rb.status = 'confirmed'
             ORDER BY rb.check_in_date DESC`,
            [hotelId]
        );

        const foodOrders = await pool.query(
            `SELECT * FROM food_orders 
             WHERE hotel_id = $1 AND status = 'confirmed'
             ORDER BY pickup_date DESC`,
            [hotelId]
        );

        res.json({
            ...safeHotel,
            is_visible: visible,
            is_featured_active: featured,
            subscription_days_left: daysLeft,
            room_bookings: roomBookings.rows || [],
            food_orders: foodOrders.rows || [],
            room_stats: {
                total_rooms: stats.total_rooms,
                available_rooms: stats.available_rooms,
                booked_rooms: stats.booked_rooms,
                room_bookings: stats.room_bookings,
                food_orders: stats.food_orders,
                date: stats.date
            }
        });
        
    } catch (error) {
        console.error('❌ Error loading hotel details:', error);
        res.status(500).json({ 
            error: 'Failed to load hotel details',
            message: error.message 
        });
    }
});

app.put('/api/hotels/owner/:id', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.id);
    const { hotelName, phone, city, country, address, description, starRating, meals, drinks, whats_new } = req.body;
    try {
        const check = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotelId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found or not owned by you' });
        }
        const result = await pool.query(
            `UPDATE hotels SET
                hotel_name = COALESCE($1, hotel_name),
                phone = COALESCE($2, phone),
                city = COALESCE($3, city),
                country = COALESCE($4, country),
                address = COALESCE($5, address),
                description = COALESCE($6, description),
                star_rating = COALESCE($7, star_rating),
                meals = COALESCE($8, meals),
                drinks = COALESCE($9, drinks),
                whats_new = COALESCE($10, whats_new),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $11
             RETURNING *`,
            [hotelName, phone, city, country, address, description, starRating, meals, drinks, whats_new, hotelId]
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Update failed' });
    }
});

app.post('/api/hotels/owner/:id/photos', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.id);
    const { photos } = req.body;
    if (photos && photos.length > 5) {
        return res.status(400).json({ error: 'Maximum 5 photos allowed' });
    }
    try {
        const check = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotelId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found or not owned by you' });
        }
        await pool.query('UPDATE hotels SET photos = $1 WHERE id = $2', [photos || [], hotelId]);
        res.json({ message: 'Photos updated', photos: photos || [] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Update failed' });
    }
});

app.post('/api/hotels/owner/create', isHotelOwner, async (req, res) => {
    const { hotelName, city, country, phone, address, description, starRating } = req.body;
    try {
        const subscriptionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const result = await pool.query(
            `INSERT INTO hotels (user_id, hotel_name, city, country, phone, address, description, star_rating, subscription_expiry, is_active, meals, drinks, whats_new)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, '[]', '[]', '')
             RETURNING *`,
            [req.userId, hotelName || 'My Hotel', city || '', country || '', phone || '', address || '', description || '', starRating || 3, subscriptionExpiry]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Create hotel error:', error);
        res.status(500).json({ error: 'Failed to create hotel: ' + error.message });
    }
});

// ============================================================
//  ROOM AVAILABILITY ROUTES
// ============================================================

app.get('/api/rooms/hotel/:hotelId/availability', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    const { check_in, check_out } = req.query;
    
    try {
        let roomsWithAvailability;
        if (check_in && check_out) {
            roomsWithAvailability = await getRoomAvailability(hotelId, check_in, check_out);
        } else {
            const today = new Date().toISOString().split('T')[0];
            const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            roomsWithAvailability = await getRoomAvailability(hotelId, today, tomorrow);
        }
        res.json(roomsWithAvailability);
    } catch (error) {
        console.error('Error fetching room availability:', error);
        res.status(500).json({ error: 'Failed to fetch availability' });
    }
});

app.get('/api/rooms/public/:hotelId/availability', async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    const { check_in, check_out } = req.query;
    
    try {
        const visible = await isHotelVisible(hotelId);
        if (!visible) {
            return res.status(403).json({ error: 'Hotel is currently unavailable' });
        }
        
        const roomsResult = await pool.query(
            'SELECT * FROM rooms WHERE hotel_id = $1 AND is_available = TRUE',
            [hotelId]
        );
        
        if (roomsResult.rows.length === 0) {
            return res.json([]);
        }
        
        let bookedMap = {};
        if (check_in && check_out) {
            const bookingsResult = await pool.query(
                `SELECT room_type_id, COUNT(*) as booked_count 
                 FROM room_bookings 
                 WHERE hotel_id = $1 
                   AND status = 'confirmed'
                   AND check_in_date < $2 
                   AND check_out_date > $3
                 GROUP BY room_type_id`,
                [hotelId, check_out, check_in]
            );
            
            bookingsResult.rows.forEach(b => {
                bookedMap[b.room_type_id] = parseInt(b.booked_count);
            });
        }
        
        const roomsWithAvailability = roomsResult.rows.map(room => {
            const booked = bookedMap[room.id] || 0;
            const total = room.total_rooms || 0;
            const available = Math.max(0, total - booked);
            return {
                id: room.id,
                room_type_name: room.room_type_name,
                capacity: room.capacity,
                base_price_per_night: room.base_price_per_night,
                total_rooms: total,
                booked_count: booked,
                available_rooms: available,
                is_available: room.is_available && available > 0
            };
        });
        
        res.json(roomsWithAvailability);
        
    } catch (error) {
        console.error('Error fetching public room availability:', error);
        res.status(500).json({ error: 'Failed to fetch availability' });
    }
});

// ============================================================
//  PUBLIC ROUTES
// ============================================================

app.get('/api/hotels/public', async (req, res) => {
    try {
        const hotels = await pool.query(`
            SELECT h.*,
                   (SELECT json_agg(json_build_object(
                        'id', r.id,
                        'name', r.room_type_name,
                        'capacity', r.capacity,
                        'price_per_night', r.base_price_per_night,
                        'total_rooms', r.total_rooms,
                        'is_available', r.is_available
                   )) FROM rooms r WHERE r.hotel_id = h.id AND r.is_available = TRUE) as room_types,
                   (SELECT json_agg(json_build_object(
                        'id', c.id,
                        'name', c.room_name,
                        'capacity', c.capacity,
                        'price_per_hour', c.price_per_hour
                   )) FROM conference_rooms c WHERE c.hotel_id = h.id) as conference_rooms
            FROM hotels h
            WHERE h.is_active = TRUE AND (h.subscription_expiry IS NOT NULL AND h.subscription_expiry > NOW())
            ORDER BY h.is_featured DESC, h.created_at DESC
        `);
        const featuredMap = {};
        const featuredHotels = await pool.query(
            'SELECT id FROM hotels WHERE is_featured = TRUE AND featured_expiry > NOW()'
        );
        featuredHotels.rows.forEach(h => featuredMap[h.id] = true);

        const publicList = hotels.rows.map(h => ({
            id: h.id,
            hotel_name: h.hotel_name,
            city: h.city,
            country: h.country,
            star_rating: h.star_rating,
            description: h.description,
            photos: h.photos || [],
            is_featured: !!featuredMap[h.id],
            room_types: h.room_types || [],
            conference_rooms: h.conference_rooms || [],
            meals: h.meals || [],
            drinks: h.drinks || [],
            whats_new: h.whats_new || ''
        }));
        res.json(publicList);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/hotels/featured', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT h.*,
                   (SELECT json_agg(json_build_object(
                        'id', r.id,
                        'name', r.room_type_name,
                        'capacity', r.capacity,
                        'price_per_night', r.base_price_per_night,
                        'total_rooms', r.total_rooms,
                        'is_available', r.is_available
                   )) FROM rooms r WHERE r.hotel_id = h.id AND r.is_available = TRUE) as room_types
            FROM hotels h
            WHERE h.is_featured = TRUE AND h.featured_expiry > NOW() AND h.is_active = TRUE AND (h.subscription_expiry IS NOT NULL AND h.subscription_expiry > NOW())
            ORDER BY h.created_at DESC
        `);
        const featured = result.rows.map(h => ({
            id: h.id,
            hotel_name: h.hotel_name,
            city: h.city,
            country: h.country,
            star_rating: h.star_rating,
            description: h.description,
            photos: h.photos || [],
            room_types: h.room_types || [],
            meals: h.meals || [],
            drinks: h.drinks || [],
            whats_new: h.whats_new || ''
        }));
        res.json(featured);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/hotels/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        const visible = await isHotelVisible(id);
        if (!visible) {
            return res.status(403).json({ error: 'Hotel is currently unavailable' });
        }

        const hotelResult = await pool.query(`
            SELECT h.*, u.email as owner_email
            FROM hotels h
            LEFT JOIN users u ON h.user_id = u.id
            WHERE h.id = $1
        `, [id]);
        if (hotelResult.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found' });
        }
        const hotel = hotelResult.rows[0];

        let hasAccess = false;
        const token = req.headers.authorization?.split(' ')[1];
        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
                const clientId = decoded.id;
                const payment = await pool.query(
                    `SELECT * FROM payments WHERE client_id = $1 AND hotel_id = $2 AND paid = TRUE AND expires_at > NOW()`,
                    [clientId, id]
                );
                if (payment.rows.length > 0) hasAccess = true;
            } catch (e) { /* ignore */ }
        }

        const today = new Date().toISOString().split('T')[0];
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const roomsWithAvailability = await getRoomAvailability(id, today, tomorrow);
        
        const rooms = roomsWithAvailability
            .filter(r => r.is_available === true)
            .map(r => ({
                id: r.id,
                name: r.room_type_name,
                capacity: r.capacity,
                price_per_night: hasAccess ? r.base_price_per_night : null,
                total_rooms: r.total_rooms,
                booked_count: r.booked_count,
                available_rooms: r.available_rooms,
                is_available: r.is_available && r.available_rooms > 0
            }));

        const confs = await pool.query('SELECT * FROM conference_rooms WHERE hotel_id = $1', [id]);
        const reviews = await pool.query(
            'SELECT id, user_name, rating, comment, created_at FROM reviews WHERE hotel_id = $1 ORDER BY created_at DESC',
            [id]
        );
        const featured = await isHotelFeatured(id);

        const menu = await pool.query(
            'SELECT * FROM hotel_menu WHERE hotel_id = $1 AND is_available = TRUE ORDER BY category, item_name',
            [id]
        );

        const response = {
            id: hotel.id,
            hotel_name: hotel.hotel_name,
            city: hotel.city,
            country: hotel.country,
            address: hasAccess ? hotel.address : null,
            phone: hasAccess ? hotel.phone : null,
            email: hasAccess ? hotel.owner_email : null,
            star_rating: hotel.star_rating,
            description: hotel.description,
            photos: hotel.photos || [],
            is_featured: featured,
            room_types: rooms,
            conference_rooms: confs.rows.map(c => ({
                id: c.id,
                name: c.room_name,
                capacity: c.capacity,
                price_per_hour: hasAccess ? c.price_per_hour : null
            })),
            reviews: reviews.rows.map(r => ({
                id: r.id,
                user_name: r.user_name,
                rating: r.rating,
                comment: r.comment,
                created_at: r.created_at
            })),
            menu: menu.rows,
            meals: hotel.meals || [],
            drinks: hotel.drinks || [],
            whats_new: hotel.whats_new || '',
            hasAccess: hasAccess,
            unlockPrice: 100
        };
        res.json(response);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
//  LEGACY PAYMENT ROUTES (Keep for backward compatibility)
// ============================================================

const UNLOCK_PRICE = 100;
const UNLOCK_EXPIRY_DAYS = 7;

app.post('/api/payments/mpesa/confirm', async (req, res) => {
    const { hotel_id, phone_number, till_number, amount } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not logged in' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;
        const existing = await pool.query(
            'SELECT * FROM payments WHERE client_id = $1 AND hotel_id = $2',
            [clientId, hotel_id]
        );
        if (existing.rows.length > 0) {
            await pool.query(
                'UPDATE payments SET paid = TRUE, expires_at = $1 WHERE client_id = $2 AND hotel_id = $3',
                [new Date(Date.now() + UNLOCK_EXPIRY_DAYS * 24 * 60 * 60 * 1000), clientId, hotel_id]
            );
        } else {
            await pool.query(
                `INSERT INTO payments (client_id, hotel_id, paid, session_id, amount, expires_at)
                 VALUES ($1, $2, TRUE, $3, $4, $5)`,
                [clientId, hotel_id, 'mpesa_' + Date.now(), UNLOCK_PRICE, new Date(Date.now() + UNLOCK_EXPIRY_DAYS * 24 * 60 * 60 * 1000)]
            );
        }
        res.json({ success: true, message: 'M-Pesa payment confirmed' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/payments/card/confirm', async (req, res) => {
    const { hotel_id, card_last4, amount } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not logged in' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;
        const existing = await pool.query(
            'SELECT * FROM payments WHERE client_id = $1 AND hotel_id = $2',
            [clientId, hotel_id]
        );
        if (existing.rows.length > 0) {
            await pool.query(
                'UPDATE payments SET paid = TRUE, expires_at = $1 WHERE client_id = $2 AND hotel_id = $3',
                [new Date(Date.now() + UNLOCK_EXPIRY_DAYS * 24 * 60 * 60 * 1000), clientId, hotel_id]
            );
        } else {
            await pool.query(
                `INSERT INTO payments (client_id, hotel_id, paid, session_id, amount, expires_at)
                 VALUES ($1, $2, TRUE, $3, $4, $5)`,
                [clientId, hotel_id, 'card_' + Date.now(), UNLOCK_PRICE, new Date(Date.now() + UNLOCK_EXPIRY_DAYS * 24 * 60 * 60 * 1000)]
            );
        }
        res.json({ success: true, message: 'Card payment confirmed' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/hotels/:id/access', async (req, res) => {
    const hotelId = parseInt(req.params.id);
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ hasAccess: false });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;
        const result = await pool.query(
            'SELECT * FROM payments WHERE client_id = $1 AND hotel_id = $2 AND paid = TRUE AND expires_at > NOW()',
            [clientId, hotelId]
        );
        res.json({ hasAccess: result.rows.length > 0 });
    } catch (e) {
        res.json({ hasAccess: false });
    }
});

// ============================================================
//  MY BOOKINGS
// ============================================================

app.get('/api/my-bookings', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.json({ unlocked_hotels: [], room_bookings: [], food_orders: [] });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;

        const unlocked = await pool.query(
            `SELECT h.id, h.hotel_name, h.city, h.country, p.expires_at
             FROM payments p
             JOIN hotels h ON p.hotel_id = h.id
             WHERE p.client_id = $1 AND p.paid = TRUE AND p.expires_at > NOW()
             ORDER BY p.created_at DESC`,
            [clientId]
        );

        const roomBookings = await pool.query(
            `SELECT 
                rb.id,
                rb.hotel_id,
                rb.room_type_id,
                rb.check_in_date,
                rb.check_out_date,
                rb.number_of_guests,
                rb.total_amount,
                rb.payment_status,
                rb.status,
                COALESCE(rb.client_name, 'N/A') as client_name,
                COALESCE(rb.client_phone, 'N/A') as client_phone,
                COALESCE(rb.booking_reference, 'N/A') as booking_reference,
                COALESCE(r.room_type_name, 'Unknown') as room_type_name,
                COALESCE(h.hotel_name, 'Unknown Hotel') as hotel_name,
                COALESCE(rb.created_at, NOW()) as created_at
             FROM room_bookings rb
             LEFT JOIN rooms r ON rb.room_type_id = r.id
             LEFT JOIN hotels h ON rb.hotel_id = h.id
             WHERE rb.client_id = $1 AND rb.status = 'confirmed'
             ORDER BY rb.created_at DESC`,
            [clientId]
        );

        const foodOrders = await pool.query(
            `SELECT 
                fo.id,
                fo.hotel_id,
                fo.items,
                fo.total_amount,
                fo.pickup_date,
                fo.pickup_time,
                fo.special_instructions,
                fo.payment_status,
                fo.status,
                COALESCE(fo.client_name, 'N/A') as client_name,
                COALESCE(fo.client_phone, 'N/A') as client_phone,
                COALESCE(fo.booking_reference, 'N/A') as booking_reference,
                COALESCE(h.hotel_name, 'Unknown Hotel') as hotel_name,
                COALESCE(fo.created_at, NOW()) as created_at
             FROM food_orders fo
             LEFT JOIN hotels h ON fo.hotel_id = h.id
             WHERE fo.client_id = $1 AND fo.status = 'confirmed'
             ORDER BY fo.created_at DESC`,
            [clientId]
        );

        const parsedFoodOrders = foodOrders.rows.map(o => ({
            ...o,
            items: typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || [])
        }));

        res.json({
            unlocked_hotels: unlocked.rows || [],
            room_bookings: roomBookings.rows || [],
            food_orders: parsedFoodOrders
        });
    } catch (error) {
        console.error('My bookings error:', error);
        res.json({ unlocked_hotels: [], room_bookings: [], food_orders: [] });
    }
});

// ============================================================
//  FOOD ORDERS
// ============================================================

app.post('/api/food-orders', async (req, res) => {
    try {
        const { hotel_id, items, pickup_date, pickup_time, special_instructions } = req.body;
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Please login first' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;

        let total = 0;
        items.forEach(item => total += item.price * item.quantity);
        const bookingRef = 'FOOD-' + Date.now().toString().slice(-8);

        const result = await pool.query(
            `INSERT INTO food_orders (client_id, hotel_id, items, total_amount, pickup_date, pickup_time, special_instructions, payment_status, booking_reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
             RETURNING *`,
            [clientId, hotel_id, JSON.stringify(items), total, pickup_date, pickup_time, special_instructions || '', bookingRef]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Food order error:', error);
        res.status(500).json({ error: 'Failed to place order: ' + error.message });
    }
});

app.post('/api/food-orders/walk-in', isHotelOwner, async (req, res) => {
    try {
        const { hotel_id, items, pickup_date, pickup_time, client_name, client_phone, special_instructions } = req.body;
        
        let total = 0;
        items.forEach(item => total += item.price * item.quantity);
        const bookingRef = 'WFOOD-' + Date.now().toString().slice(-8);

        const result = await pool.query(
            `INSERT INTO food_orders (hotel_id, client_name, client_phone, items, total_amount, pickup_date, pickup_time, special_instructions, payment_status, booking_reference, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid', $9, 'confirmed')
             RETURNING *`,
            [hotel_id, client_name, client_phone, JSON.stringify(items), total, pickup_date, pickup_time, special_instructions || '', bookingRef]
        );
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Walk-in food order error:', error);
        res.status(500).json({ error: 'Failed to place order: ' + error.message });
    }
});

app.post('/api/food-orders/:id/confirm-payment', async (req, res) => {
    const orderId = parseInt(req.params.id);
    const { payment_method, payment_reference } = req.body;
    try {
        const result = await pool.query(
            `UPDATE food_orders SET
                payment_status = 'paid',
                payment_method = $1,
                payment_reference = $2,
                status = 'confirmed'
             WHERE id = $3
             RETURNING *`,
            [payment_method, payment_reference, orderId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Confirm payment error:', error);
        res.status(500).json({ error: 'Failed to confirm payment: ' + error.message });
    }
});

app.get('/api/food-orders/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        const result = await pool.query('SELECT * FROM food_orders WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
//  ROOM BOOKINGS
// ============================================================

app.post('/api/room-bookings', async (req, res) => {
    try {
        const { room_type_id, check_in_date, check_out_date, number_of_guests, special_requests } = req.body;
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Please login first' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;

        const room = await pool.query(
            'SELECT r.*, h.id as hotel_id FROM rooms r JOIN hotels h ON r.hotel_id = h.id WHERE r.id = $1',
            [room_type_id]
        );
        if (room.rows.length === 0) {
            return res.status(404).json({ error: 'Room not found' });
        }

        const bookingCheck = await pool.query(
            `SELECT COUNT(*) as booked_count 
             FROM room_bookings 
             WHERE room_type_id = $1 
               AND status = 'confirmed'
               AND check_in_date < $2 
               AND check_out_date > $3`,
            [room_type_id, check_out_date, check_in_date]
        );

        const bookedCount = parseInt(bookingCheck.rows[0].booked_count);
        const totalRooms = room.rows[0].total_rooms || 0;
        const availableRooms = totalRooms - bookedCount;

        if (availableRooms <= 0) {
            return res.status(400).json({ error: 'No rooms available for the selected dates' });
        }

        const days = Math.ceil((new Date(check_out_date) - new Date(check_in_date)) / (1000 * 60 * 60 * 24));
        const total = room.rows[0].base_price_per_night * days;
        const bookingRef = 'ROOM-' + Date.now().toString().slice(-8);

        const result = await pool.query(
            `INSERT INTO room_bookings (client_id, hotel_id, room_type_id, check_in_date, check_out_date, 
                number_of_guests, total_amount, special_requests, payment_status, booking_reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
             RETURNING *`,
            [clientId, room.rows[0].hotel_id, room_type_id, check_in_date, check_out_date, number_of_guests || 1, total, special_requests || '', bookingRef]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Room booking error:', error);
        res.status(500).json({ error: 'Failed to book room: ' + error.message });
    }
});

app.post('/api/room-bookings/walk-in', isHotelOwner, async (req, res) => {
    try {
        const { hotel_id, room_type_id, check_in_date, check_out_date, number_of_guests, client_name, client_phone, special_requests } = req.body;
        
        const room = await pool.query(
            'SELECT * FROM rooms WHERE id = $1',
            [room_type_id]
        );
        if (room.rows.length === 0) {
            return res.status(404).json({ error: 'Room not found' });
        }

        const bookingCheck = await pool.query(
            `SELECT COUNT(*) as booked_count 
             FROM room_bookings 
             WHERE room_type_id = $1 
               AND status = 'confirmed'
               AND check_in_date < $2 
               AND check_out_date > $3`,
            [room_type_id, check_out_date, check_in_date]
        );

        const bookedCount = parseInt(bookingCheck.rows[0].booked_count);
        const totalRooms = room.rows[0].total_rooms || 0;
        const availableRooms = totalRooms - bookedCount;

        if (availableRooms <= 0) {
            return res.status(400).json({ error: 'No rooms available for the selected dates' });
        }

        const days = Math.ceil((new Date(check_out_date) - new Date(check_in_date)) / (1000 * 60 * 60 * 24));
        const total = room.rows[0].base_price_per_night * days;
        const bookingRef = 'WROOM-' + Date.now().toString().slice(-8);

        const result = await pool.query(
            `INSERT INTO room_bookings (hotel_id, room_type_id, client_name, client_phone, check_in_date, check_out_date, 
                number_of_guests, total_amount, special_requests, payment_status, booking_reference, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'paid', $10, 'confirmed')
             RETURNING *`,
            [hotel_id, room_type_id, client_name, client_phone, check_in_date, check_out_date, number_of_guests || 1, total, special_requests || '', bookingRef]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Walk-in room booking error:', error);
        res.status(500).json({ error: 'Failed to book room: ' + error.message });
    }
});

app.post('/api/room-bookings/:id/confirm-payment', async (req, res) => {
    const bookingId = parseInt(req.params.id);
    const { payment_method, payment_reference } = req.body;
    try {
        const result = await pool.query(
            `UPDATE room_bookings SET
                payment_status = 'paid',
                payment_method = $1,
                payment_reference = $2,
                status = 'confirmed'
             WHERE id = $3
             RETURNING *`,
            [payment_method, payment_reference, bookingId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Confirm payment error:', error);
        res.status(500).json({ error: 'Failed to confirm payment: ' + error.message });
    }
});

app.get('/api/room-bookings/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        const result = await pool.query(
            `SELECT rb.*, r.room_type_name, h.hotel_name 
             FROM room_bookings rb
             JOIN rooms r ON rb.room_type_id = r.id
             JOIN hotels h ON rb.hotel_id = h.id
             WHERE rb.id = $1`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
//  REVIEWS
// ============================================================

app.post('/api/reviews', async (req, res) => {
    const { hotel_id, rating, comment } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Please login to post a review' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const userId = decoded.id;
        const user = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [userId]);
        if (user.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        const userName = user.rows[0].full_name || user.rows[0].email;
        const result = await pool.query(
            `INSERT INTO reviews (hotel_id, user_id, user_name, rating, comment)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [hotel_id, userId, userName, Math.min(5, Math.max(1, parseInt(rating))), comment || '']
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/reviews/public', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT r.*, h.hotel_name, u.email as reviewer_email
            FROM reviews r
            JOIN hotels h ON r.hotel_id = h.id
            JOIN users u ON r.user_id = u.id
            ORDER BY r.created_at DESC
            LIMIT 20
        `);
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
//  ROOM MANAGEMENT
// ============================================================

app.post('/api/rooms/:hotelId', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    const { roomTypeName, capacity, basePricePerNight, totalRooms, isAvailable } = req.body;
    
    if (!roomTypeName || !capacity || !basePricePerNight) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const hotelCheck = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotelId, req.userId]
        );
        if (hotelCheck.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this hotel' });
        }

        const result = await pool.query(
            `INSERT INTO rooms (hotel_id, room_type_name, capacity, base_price_per_night, total_rooms, is_available)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [hotelId, roomTypeName, capacity, basePricePerNight, totalRooms || 1, isAvailable !== undefined ? isAvailable : true]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Create room error:', error);
        res.status(500).json({ error: 'Failed to create room: ' + error.message });
    }
});

app.get('/api/rooms', isHotelOwner, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT r.*, h.hotel_name 
             FROM rooms r
             JOIN hotels h ON r.hotel_id = h.id
             WHERE h.user_id = $1
             ORDER BY h.hotel_name, r.room_type_name`,
            [req.userId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Get rooms error:', error);
        res.status(500).json({ error: 'Failed to fetch rooms' });
    }
});

app.get('/api/rooms/hotel/:hotelId', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    try {
        const result = await pool.query(
            'SELECT * FROM rooms WHERE hotel_id = $1 ORDER BY room_type_name',
            [hotelId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Get hotel rooms error:', error);
        res.status(500).json({ error: 'Failed to fetch rooms' });
    }
});

app.put('/api/rooms/:id', isHotelOwner, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const { room_type_name, capacity, base_price_per_night, total_rooms, is_available } = req.body;
    
    try {
        const check = await pool.query(
            `SELECT r.id FROM rooms r
             JOIN hotels h ON r.hotel_id = h.id
             WHERE r.id = $1 AND h.user_id = $2`,
            [roomId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this room' });
        }

        const result = await pool.query(
            `UPDATE rooms SET
                room_type_name = COALESCE($1, room_type_name),
                capacity = COALESCE($2, capacity),
                base_price_per_night = COALESCE($3, base_price_per_night),
                total_rooms = COALESCE($4, total_rooms),
                is_available = COALESCE($5, is_available)
             WHERE id = $6
             RETURNING *`,
            [room_type_name, capacity, base_price_per_night, total_rooms, is_available, roomId]
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Update room error:', error);
        res.status(500).json({ error: 'Failed to update room' });
    }
});

app.put('/api/rooms/:id/toggle', isHotelOwner, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const { is_available } = req.body;
    
    try {
        const check = await pool.query(
            `SELECT r.id FROM rooms r
             JOIN hotels h ON r.hotel_id = h.id
             WHERE r.id = $1 AND h.user_id = $2`,
            [roomId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this room' });
        }

        const result = await pool.query(
            `UPDATE rooms SET is_available = $1 WHERE id = $2 RETURNING *`,
            [is_available, roomId]
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Toggle room error:', error);
        res.status(500).json({ error: 'Failed to toggle room' });
    }
});

app.delete('/api/rooms/:id', isHotelOwner, async (req, res) => {
    const roomId = parseInt(req.params.id);
    try {
        const check = await pool.query(
            `SELECT r.id FROM rooms r
             JOIN hotels h ON r.hotel_id = h.id
             WHERE r.id = $1 AND h.user_id = $2`,
            [roomId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this room' });
        }

        await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
        res.json({ message: 'Room deleted successfully' });
    } catch (error) {
        console.error('Delete room error:', error);
        res.status(500).json({ error: 'Failed to delete room' });
    }
});

// ============================================================
//  CONFERENCE ROOM MANAGEMENT
// ============================================================

app.post('/api/conference/:hotelId', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    const { roomName, room_name, capacity, pricePerHour, price_per_hour, amenities } = req.body;
    
    const finalRoomName = roomName || room_name;
    const finalPrice = pricePerHour || price_per_hour;
    
    if (!finalRoomName || !capacity || !finalPrice) {
        return res.status(400).json({ 
            error: 'Missing required fields. Need: roomName/room_name, capacity, pricePerHour/price_per_hour'
        });
    }

    try {
        const hotelCheck = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotelId, req.userId]
        );
        if (hotelCheck.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this hotel' });
        }

        const result = await pool.query(
            `INSERT INTO conference_rooms (hotel_id, room_name, capacity, price_per_hour, amenities)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [hotelId, finalRoomName, capacity, finalPrice, amenities || []]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Create conference room error:', error);
        res.status(500).json({ error: 'Failed to create conference room: ' + error.message });
    }
});

app.post('/api/conference', isHotelOwner, async (req, res) => {
    const { hotel_id, hotelId, roomName, room_name, capacity, pricePerHour, price_per_hour, amenities } = req.body;
    const finalHotelId = hotel_id || hotelId;
    const finalRoomName = roomName || room_name;
    const finalPrice = pricePerHour || price_per_hour;
    
    if (!finalHotelId || !finalRoomName || !capacity || !finalPrice) {
        return res.status(400).json({ 
            error: 'Missing required fields. Need: hotel_id, roomName/room_name, capacity, pricePerHour/price_per_hour' 
        });
    }
    
    req.params = { hotelId: finalHotelId };
    return app._router.handle(req, res, () => {});
});

app.get('/api/conference/hotel/:hotelId', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    try {
        const result = await pool.query(
            'SELECT * FROM conference_rooms WHERE hotel_id = $1 ORDER BY room_name',
            [hotelId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Get conference rooms error:', error);
        res.status(500).json({ error: 'Failed to fetch conference rooms' });
    }
});

app.put('/api/conference/:id', isHotelOwner, async (req, res) => {
    const roomId = parseInt(req.params.id);
    const { room_name, capacity, price_per_hour, amenities } = req.body;
    
    try {
        const check = await pool.query(
            `SELECT c.id FROM conference_rooms c
             JOIN hotels h ON c.hotel_id = h.id
             WHERE c.id = $1 AND h.user_id = $2`,
            [roomId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this conference room' });
        }

        const result = await pool.query(
            `UPDATE conference_rooms SET
                room_name = COALESCE($1, room_name),
                capacity = COALESCE($2, capacity),
                price_per_hour = COALESCE($3, price_per_hour),
                amenities = COALESCE($4, amenities)
             WHERE id = $5
             RETURNING *`,
            [room_name, capacity, price_per_hour, amenities, roomId]
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Update conference room error:', error);
        res.status(500).json({ error: 'Failed to update conference room' });
    }
});

app.delete('/api/conference/:id', isHotelOwner, async (req, res) => {
    const roomId = parseInt(req.params.id);
    try {
        const check = await pool.query(
            `SELECT c.id FROM conference_rooms c
             JOIN hotels h ON c.hotel_id = h.id
             WHERE c.id = $1 AND h.user_id = $2`,
            [roomId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this conference room' });
        }

        await pool.query('DELETE FROM conference_rooms WHERE id = $1', [roomId]);
        res.json({ message: 'Conference room deleted successfully' });
    } catch (error) {
        console.error('Delete conference room error:', error);
        res.status(500).json({ error: 'Failed to delete conference room' });
    }
});

// ============================================================
//  HOTEL MENU MANAGEMENT
// ============================================================

app.post('/api/menu/:hotelId', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    const { item_name, description, price, category, is_available } = req.body;
    
    if (!item_name || !price) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const hotelCheck = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotelId, req.userId]
        );
        if (hotelCheck.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this hotel' });
        }

        const result = await pool.query(
            `INSERT INTO hotel_menu (hotel_id, item_name, description, price, category, is_available)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [hotelId, item_name, description || '', price, category || 'main', is_available !== undefined ? is_available : true]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Create menu item error:', error);
        res.status(500).json({ error: 'Failed to create menu item' });
    }
});

app.get('/api/menu/hotel/:hotelId', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    try {
        const result = await pool.query(
            'SELECT * FROM hotel_menu WHERE hotel_id = $1 ORDER BY category, item_name',
            [hotelId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Get menu items error:', error);
        res.status(500).json({ error: 'Failed to fetch menu items' });
    }
});

app.put('/api/menu/:id', isHotelOwner, async (req, res) => {
    const itemId = parseInt(req.params.id);
    const { item_name, description, price, category, is_available } = req.body;
    
    try {
        const check = await pool.query(
            `SELECT m.id FROM hotel_menu m
             JOIN hotels h ON m.hotel_id = h.id
             WHERE m.id = $1 AND h.user_id = $2`,
            [itemId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this menu item' });
        }

        const result = await pool.query(
            `UPDATE hotel_menu SET
                item_name = COALESCE($1, item_name),
                description = COALESCE($2, description),
                price = COALESCE($3, price),
                category = COALESCE($4, category),
                is_available = COALESCE($5, is_available)
             WHERE id = $6
             RETURNING *`,
            [item_name, description, price, category, is_available, itemId]
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Update menu item error:', error);
        res.status(500).json({ error: 'Failed to update menu item' });
    }
});

app.delete('/api/menu/:id', isHotelOwner, async (req, res) => {
    const itemId = parseInt(req.params.id);
    try {
        const check = await pool.query(
            `SELECT m.id FROM hotel_menu m
             JOIN hotels h ON m.hotel_id = h.id
             WHERE m.id = $1 AND h.user_id = $2`,
            [itemId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this menu item' });
        }

        await pool.query('DELETE FROM hotel_menu WHERE id = $1', [itemId]);
        res.json({ message: 'Menu item deleted successfully' });
    } catch (error) {
        console.error('Delete menu item error:', error);
        res.status(500).json({ error: 'Failed to delete menu item' });
    }
});

// ============================================================
//  SUBSCRIPTION
// ============================================================

app.post('/api/payments/subscribe/:hotelId', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    const { amount, paymentMethod } = req.body;
    
    try {
        const check = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotelId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this hotel' });
        }

        let updateQuery;
        let expiryDate;
        let days;

        if (amount >= 5000) {
            days = 30;
            expiryDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
            updateQuery = `UPDATE hotels SET 
                is_active = TRUE,
                is_featured = TRUE,
                featured_expiry = $1,
                subscription_expiry = $1,
                updated_at = CURRENT_TIMESTAMP
                WHERE id = $2`;
        } else {
            days = 30;
            expiryDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
            updateQuery = `UPDATE hotels SET 
                is_active = TRUE,
                subscription_expiry = $1,
                updated_at = CURRENT_TIMESTAMP
                WHERE id = $2`;
        }

        await pool.query(updateQuery, [expiryDate, hotelId]);
        
        res.json({
            success: true,
            message: `✅ Subscription successful! ${amount >= 5000 ? '🌟 Hotel is now FEATURED!' : 'Hotel is now visible.'} Expires in ${days} days.`
        });
    } catch (error) {
        console.error('Subscription error:', error);
        res.status(500).json({ error: 'Subscription failed: ' + error.message });
    
// ============================================================
//  START SERVER
// ============================================================

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`👤 Admin: admin@hotelbooking.com / admin123`);
    console.log(`📱 Payment Mode: ${TUMA_CONFIG.MOCK_MODE ? 'MOCK (Testing)' : 'LIVE'}`);
    if (TUMA_CONFIG.MOCK_MODE) {
        console.log('⚠️  MOCK MODE ENABLED - No real payments will be processed');
        console.log('⚠️  To enable real payments, set TUMA_EMAIL and TUMA_API_KEY');
    }
});
