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

// ===== ENSURE ADMIN USER EXISTS =====
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

// ===== AUTH =====
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
            { id: user.id, userType: user.user_type },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '7d' }
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
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/auth/register', async (req, res) => {
    const { email, password, userType, companyName, fullName, phone } = req.body;
    try {
        const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (exists.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (email, password_hash, user_type, company_name, full_name, phone, is_verified)
             VALUES ($1, $2, $3, $4, $5, $6, FALSE)
             RETURNING id, email, user_type, full_name`,
            [email, hashedPassword, userType, companyName || null, fullName || null, phone || null]
        );
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 600000);
        await pool.query(
            `INSERT INTO verifications (user_id, code, type, expires_at)
             VALUES ($1, $2, 'email', $3)`,
            [result.rows[0].id, otp, expires]
        );
        res.json({
            success: true,
            message: 'OTP sent to your email',
            otp: otp,
            userId: result.rows[0].id
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/auth/verify-otp', async (req, res) => {
    const { userId, otp } = req.body;
    try {
        const result = await pool.query(
            'SELECT id FROM verifications WHERE user_id = $1 AND code = $2 AND expires_at > NOW()',
            [userId, otp]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired OTP' });
        }
        await pool.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [userId]);
        await pool.query('DELETE FROM verifications WHERE user_id = $1', [userId]);
        const user = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        const token = jwt.sign(
            { id: user.rows[0].id, userType: user.rows[0].user_type },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '7d' }
        );
        res.json({
            token,
            user: {
                id: user.rows[0].id,
                email: user.rows[0].email,
                userType: user.rows[0].user_type,
                full_name: user.rows[0].full_name
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ===== MIDDLEWARE =====
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

// ===== ADMIN ROUTES =====
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

// ===== HOTEL OWNER ROUTES =====
const isHotelVisible = async (hotelId) => {
    const result = await pool.query('SELECT is_active, subscription_expiry FROM hotels WHERE id = $1', [hotelId]);
    if (result.rows.length === 0) return false;
    const hotel = result.rows[0];
    if (!hotel.is_active) return false;
    if (!hotel.subscription_expiry) return false;
    return new Date(hotel.subscription_expiry) > new Date();
};

const isHotelFeatured = async (hotelId) => {
    const result = await pool.query('SELECT is_featured, featured_expiry FROM hotels WHERE id = $1', [hotelId]);
    if (result.rows.length === 0) return false;
    const hotel = result.rows[0];
    if (!hotel.is_featured) return false;
    if (!hotel.featured_expiry) return false;
    return new Date(hotel.featured_expiry) > new Date();
};

app.get('/api/hotels/owner', isHotelOwner, async (req, res) => {
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
        const visible = await isHotelVisible(hotel.id);
        const featured = await isHotelFeatured(hotel.id);
        const daysLeft = hotel.subscription_expiry ?
            Math.max(0, Math.ceil((new Date(hotel.subscription_expiry) - new Date()) / (1000 * 60 * 60 * 24))) :
            0;

        const roomBookings = await pool.query(
            `SELECT rb.*, r.room_type_name 
             FROM room_bookings rb
             JOIN rooms r ON rb.room_type_id = r.id
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

        const roomStats = await pool.query(
            `SELECT 
                COUNT(*) as total_room_types,
                SUM(total_rooms) as total_rooms,
                SUM(CASE WHEN is_available THEN total_rooms ELSE 0 END) as available_rooms
             FROM rooms WHERE hotel_id = $1`,
            [hotelId]
        );

        res.json({
            ...hotel,
            is_visible: visible,
            is_featured_active: featured,
            subscription_days_left: daysLeft,
            room_bookings: roomBookings.rows,
            food_orders: foodOrders.rows,
            room_stats: roomStats.rows[0] || { total_room_types: 0, total_rooms: 0, available_rooms: 0 }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
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
            `INSERT INTO hotels (user_id, hotel_name, city, country, phone, address, description, star_rating, subscription_expiry, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
             RETURNING *`,
            [req.userId, hotelName || 'My Hotel', city || '', country || '', phone || '', address || '', description || '', starRating || 3, subscriptionExpiry]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create hotel' });
    }
});

// ===== SUBSCRIPTION =====
app.post('/api/payments/subscribe/:hotelId', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    const { amount, paymentMethod } = req.body;
    try {
        const check = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotelId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found or not owned by you' });
        }
        const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        if (amount === 1000) {
            await pool.query('UPDATE hotels SET subscription_expiry = $1 WHERE id = $2', [expiry, hotelId]);
            await pool.query(
                'INSERT INTO subscriptions (hotel_id, amount, type, payment_method, expires_at) VALUES ($1, $2, $3, $4, $5)',
                [hotelId, 1000, 'subscription', paymentMethod || 'mpesa', expiry]
            );
            res.json({ success: true, message: '✅ Subscription activated for 30 days!', expiry });
        } else if (amount === 5000) {
            await pool.query(
                'UPDATE hotels SET subscription_expiry = $1, is_featured = TRUE, featured_expiry = $1 WHERE id = $2',
                [expiry, hotelId]
            );
            await pool.query(
                'INSERT INTO subscriptions (hotel_id, amount, type, payment_method, expires_at) VALUES ($1, $2, $3, $4, $5)',
                [hotelId, 5000, 'featured', paymentMethod || 'mpesa', expiry]
            );
            res.json({ success: true, message: '✅ Featured subscription activated for 30 days!', expiry });
        } else {
            res.status(400).json({ error: 'Invalid subscription amount' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Subscription failed' });
    }
});

// ===== ROOMS =====
app.post('/api/rooms/:hotelId', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    const { roomTypeName, capacity, basePricePerNight, totalRooms } = req.body;
    try {
        const check = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotelId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found or not owned by you' });
        }
        const result = await pool.query(
            `INSERT INTO rooms (hotel_id, room_type_name, capacity, base_price_per_night, total_rooms, is_available)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             RETURNING *`,
            [hotelId, roomTypeName, capacity, basePricePerNight, totalRooms]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to add room' });
    }
});

app.get('/api/rooms/hotel/:hotelId', async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    try {
        const result = await pool.query('SELECT * FROM rooms WHERE hotel_id = $1 ORDER BY id', [hotelId]);
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/rooms/:id/toggle', isHotelOwner, async (req, res) => {
    const id = parseInt(req.params.id);
    const { is_available } = req.body;
    try {
        const check = await pool.query(
            `SELECT r.id FROM rooms r
             JOIN hotels h ON r.hotel_id = h.id
             WHERE r.id = $1 AND h.user_id = $2`,
            [id, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Room not found' });
        }
        const result = await pool.query(
            'UPDATE rooms SET is_available = $1 WHERE id = $2 RETURNING *',
            [is_available, id]
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Update failed' });
    }
});

app.put('/api/rooms/:id', isHotelOwner, async (req, res) => {
    const id = parseInt(req.params.id);
    const { room_type_name, capacity, base_price_per_night, total_rooms } = req.body;
    try {
        const check = await pool.query(
            `SELECT r.id FROM rooms r
             JOIN hotels h ON r.hotel_id = h.id
             WHERE r.id = $1 AND h.user_id = $2`,
            [id, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Room not found' });
        }
        const result = await pool.query(
            `UPDATE rooms SET
                room_type_name = COALESCE($1, room_type_name),
                capacity = COALESCE($2, capacity),
                base_price_per_night = COALESCE($3, base_price_per_night),
                total_rooms = COALESCE($4, total_rooms)
             WHERE id = $5
             RETURNING *`,
            [room_type_name, capacity, base_price_per_night, total_rooms, id]
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Update failed' });
    }
});

app.delete('/api/rooms/:id', isHotelOwner, async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        const check = await pool.query(
            `SELECT r.id FROM rooms r
             JOIN hotels h ON r.hotel_id = h.id
             WHERE r.id = $1 AND h.user_id = $2`,
            [id, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Room not found' });
        }
        await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
        res.json({ message: 'Deleted' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// ===== CONFERENCE =====
app.post('/api/conference/:hotelId', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    const { roomName, capacity, pricePerHour } = req.body;
    try {
        const check = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotelId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found or not owned by you' });
        }
        const result = await pool.query(
            `INSERT INTO conference_rooms (hotel_id, room_name, capacity, price_per_hour, is_available)
             VALUES ($1, $2, $3, $4, TRUE)
             RETURNING *`,
            [hotelId, roomName, capacity, pricePerHour]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to add conference room' });
    }
});

app.get('/api/conference/hotel/:hotelId', async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    try {
        const result = await pool.query('SELECT * FROM conference_rooms WHERE hotel_id = $1 ORDER BY id', [hotelId]);
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/conference/bookings', isHotelOwner, async (req, res) => {
    const { conferenceRoomId, bookingDate, startTime, endTime, purpose } = req.body;
    try {
        const check = await pool.query(
            `SELECT c.id FROM conference_rooms c
             JOIN hotels h ON c.hotel_id = h.id
             WHERE c.id = $1 AND h.user_id = $2`,
            [conferenceRoomId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Conference room not found' });
        }
        const conflict = await pool.query(
            `SELECT id FROM conference_bookings
             WHERE conference_room_id = $1 AND booking_date = $2 AND status = 'confirmed'
             AND (($3 >= start_time AND $3 < end_time) OR ($4 > start_time AND $4 <= end_time))`,
            [conferenceRoomId, bookingDate, startTime, endTime]
        );
        if (conflict.rows.length > 0) {
            return res.status(400).json({ error: 'Time slot already booked' });
        }
        const result = await pool.query(
            `INSERT INTO conference_bookings (conference_room_id, booked_by, booking_date, start_time, end_time, purpose, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')
             RETURNING *`,
            [conferenceRoomId, req.userId, bookingDate, startTime, endTime, purpose || '']
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Booking failed' });
    }
});

app.get('/api/conference/hotel/:hotelId/availability', async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    try {
        const confs = await pool.query('SELECT * FROM conference_rooms WHERE hotel_id = $1', [hotelId]);
        const result = await Promise.all(confs.rows.map(async (c) => {
            const bookings = await pool.query(
                `SELECT booking_date as date, start_time as start, end_time as end
                 FROM conference_bookings
                 WHERE conference_room_id = $1 AND status = 'confirmed'`,
                [c.id]
            );
            return { ...c, bookings: bookings.rows };
        }));
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ===== MENU =====
app.get('/api/menu/hotel/:hotelId', async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    try {
        const result = await pool.query(
            'SELECT * FROM hotel_menu WHERE hotel_id = $1 ORDER BY category, item_name',
            [hotelId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/menu/:hotelId', isHotelOwner, async (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    const { item_name, description, price, category } = req.body;
    try {
        const check = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotelId, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found or not owned by you' });
        }
        const result = await pool.query(
            `INSERT INTO hotel_menu (hotel_id, item_name, description, price, category)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [hotelId, item_name, description, price, category || 'main']
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to add menu item' });
    }
});

app.put('/api/menu/:id', isHotelOwner, async (req, res) => {
    const id = parseInt(req.params.id);
    const { item_name, description, price, category, is_available } = req.body;
    try {
        const check = await pool.query(
            `SELECT m.id FROM hotel_menu m
             JOIN hotels h ON m.hotel_id = h.id
             WHERE m.id = $1 AND h.user_id = $2`,
            [id, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Menu item not found' });
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
            [item_name, description, price, category, is_available, id]
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to update menu item' });
    }
});

app.delete('/api/menu/:id', isHotelOwner, async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        const check = await pool.query(
            `SELECT m.id FROM hotel_menu m
             JOIN hotels h ON m.hotel_id = h.id
             WHERE m.id = $1 AND h.user_id = $2`,
            [id, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Menu item not found' });
        }
        await pool.query('DELETE FROM hotel_menu WHERE id = $1', [id]);
        res.json({ message: 'Menu item deleted' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to delete menu item' });
    }
});

// ===== FOOD ORDERS =====
app.post('/api/food-orders', async (req, res) => {
    const { hotel_id, items, pickup_date, pickup_time, special_instructions } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Please login first' });

    try {
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
        console.error(error);
        res.status(500).json({ error: 'Failed to place order' });
    }
});

app.get('/api/food-orders/client', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Please login' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;
        const result = await pool.query(
            'SELECT * FROM food_orders WHERE client_id = $1 ORDER BY created_at DESC',
            [decoded.id]
        );
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
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
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to confirm payment' });
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

// ===== ROOM BOOKINGS =====
app.post('/api/room-bookings', async (req, res) => {
    const { room_type_id, check_in_date, check_out_date, number_of_guests, special_requests } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Please login first' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;

        const room = await pool.query(
            'SELECT r.*, h.id as hotel_id FROM rooms r JOIN hotels h ON r.hotel_id = h.id WHERE r.id = $1 AND r.is_available = TRUE',
            [room_type_id]
        );
        if (room.rows.length === 0) {
            return res.status(404).json({ error: 'Room not found or unavailable' });
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
        console.error(error);
        res.status(500).json({ error: 'Failed to book room' });
    }
});

app.get('/api/room-bookings/client', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Please login' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;
        const result = await pool.query(
            `SELECT rb.*, r.room_type_name, h.hotel_name 
             FROM room_bookings rb
             JOIN rooms r ON rb.room_type_id = r.id
             JOIN hotels h ON rb.hotel_id = h.id
             WHERE rb.client_id = $1 AND rb.status = 'confirmed'
             ORDER BY rb.created_at DESC`,
            [clientId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server error' });
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
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to confirm payment' });
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

// ===== PAYMENTS (Client Unlock) =====
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

// ===== WALK-IN BOOKINGS =====
app.post('/api/room-bookings/walk-in', isHotelOwner, async (req, res) => {
    const { hotel_id, room_type_id, check_in_date, check_out_date, number_of_guests, client_name, client_phone, special_requests } = req.body;
    try {
        const check = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotel_id, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found or not owned by you' });
        }

        const room = await pool.query('SELECT base_price_per_night FROM rooms WHERE id = $1', [room_type_id]);
        if (room.rows.length === 0) {
            return res.status(404).json({ error: 'Room not found' });
        }

        const days = Math.ceil((new Date(check_out_date) - new Date(check_in_date)) / (1000 * 60 * 60 * 24));
        const total = room.rows[0].base_price_per_night * days;
        const bookingRef = 'WALK-' + Date.now().toString().slice(-8);

        const result = await pool.query(
            `INSERT INTO room_bookings 
                (hotel_id, room_type_id, check_in_date, check_out_date, number_of_guests, 
                 client_name, client_phone, special_requests, total_amount, payment_status, status, booking_reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'paid', 'confirmed', $10)
             RETURNING *`,
            [hotel_id, room_type_id, check_in_date, check_out_date, number_of_guests || 1,
             client_name, client_phone, special_requests || '', total, bookingRef]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create booking' });
    }
});

app.post('/api/food-orders/walk-in', isHotelOwner, async (req, res) => {
    const { hotel_id, items, pickup_date, pickup_time, client_name, client_phone, special_instructions } = req.body;
    try {
        const check = await pool.query(
            'SELECT id FROM hotels WHERE id = $1 AND user_id = $2',
            [hotel_id, req.userId]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Hotel not found or not owned by you' });
        }

        let total = 0;
        items.forEach(item => total += item.price * item.quantity);
        const bookingRef = 'WALK-F-' + Date.now().toString().slice(-8);

        const result = await pool.query(
            `INSERT INTO food_orders 
                (hotel_id, items, total_amount, pickup_date, pickup_time, 
                 client_name, client_phone, special_instructions, payment_status, status, booking_reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid', 'confirmed', $9)
             RETURNING *`,
            [hotel_id, JSON.stringify(items), total, pickup_date, pickup_time,
             client_name, client_phone, special_instructions || '', bookingRef]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create food order' });
    }
});

// ===== PUBLIC ROUTES =====
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

        const rooms = await pool.query(
            'SELECT * FROM rooms WHERE hotel_id = $1 AND is_available = TRUE',
            [id]
        );
        const confs = await pool.query('SELECT * FROM conference_rooms WHERE hotel_id = $1', [id]);
        const reviews = await pool.query(
            'SELECT id, user_name, rating, comment, created_at FROM reviews WHERE hotel_id = $1 ORDER BY created_at DESC',
            [id]
        );
        const featured = await isHotelFeatured(id);

        const menu = await pool.query(
            'SELECT * FROM hotel_menu WHERE hotel_id = $1 ORDER BY category, item_name',
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
            room_types: rooms.rows.map(r => ({
                id: r.id,
                name: r.room_type_name,
                capacity: r.capacity,
                price_per_night: hasAccess ? r.base_price_per_night : null,
                total_rooms: r.total_rooms,
                is_available: r.is_available
            })),
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
            menu: menu.rows.map(m => ({
                id: m.id,
                item_name: m.item_name,
                description: m.description,
                price: m.price,
                category: m.category,
                is_available: m.is_available
            })),
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

// ===== REVIEWS =====
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

// ======================================================
// ===== MY BOOKINGS - SIMPLE DIRECT ROUTE =====
// ======================================================
app.get('/api/my-bookings', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ 
                error: 'No token provided',
                unlocked_hotels: [],
                room_bookings: [],
                food_orders: []
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;

        console.log('📋 Fetching bookings for client:', clientId);

        // Get unlocked hotels
        const unlocked = await pool.query(
            `SELECT h.id, h.hotel_name, h.city, h.country, p.expires_at
             FROM payments p
             JOIN hotels h ON p.hotel_id = h.id
             WHERE p.client_id = $1 AND p.paid = TRUE AND p.expires_at > NOW()
             ORDER BY p.created_at DESC`,
            [clientId]
        );

        // Get room bookings
        const roomBookings = await pool.query(
            `SELECT rb.*, r.room_type_name, h.hotel_name 
             FROM room_bookings rb
             JOIN rooms r ON rb.room_type_id = r.id
             JOIN hotels h ON rb.hotel_id = h.id
             WHERE rb.client_id = $1 AND rb.status = 'confirmed'
             ORDER BY rb.created_at DESC`,
            [clientId]
        );

        // Get food orders
        const foodOrders = await pool.query(
            `SELECT fo.*, h.hotel_name 
             FROM food_orders fo
             JOIN hotels h ON fo.hotel_id = h.id
             WHERE fo.client_id = $1 AND fo.status = 'confirmed'
             ORDER BY fo.created_at DESC`,
            [clientId]
        );

        res.json({
            unlocked_hotels: unlocked.rows || [],
            room_bookings: roomBookings.rows || [],
            food_orders: foodOrders.rows || []
        });
    } catch (error) {
        console.error('❌ My bookings error:', error);
        res.status(500).json({
            error: error.message,
            unlocked_hotels: [],
            room_bookings: [],
            food_orders: []
        });
    }
});

// ===== START SERVER =====
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`👤 Admin: admin@hotelbooking.com / admin123`);
});
