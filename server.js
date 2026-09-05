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
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error: ' + error.message });
    }
});

app.post('/api/auth/register', async (req, res) => {
    const { email, password, userType, companyName, fullName, phone } = req.body;
    try {
        // Check if user exists
        const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (exists.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert user
        const result = await pool.query(
            `INSERT INTO users (email, password_hash, user_type, company_name, full_name, phone, is_verified)
             VALUES ($1, $2, $3, $4, $5, $6, TRUE)
             RETURNING id, email, user_type, full_name`,
            [email, hashedPassword, userType, companyName || null, fullName || null, phone || null]
        );

        const user = result.rows[0];
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
        console.error('Register error:', error);
        res.status(500).json({ error: 'Server error: ' + error.message });
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

// ===== HOTEL OWNER ROUTES (simplified) =====
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

app.get('/api/hotels/me', isHotelOwner, async (req, res) => {
    const result = await pool.query('SELECT * FROM hotels WHERE user_id = $1', [req.userId]);
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No hotel found' });
    }
    const hotel = result.rows[0];
    const visible = await isHotelVisible(hotel.id);
    const featured = await isHotelFeatured(hotel.id);
    const daysLeft = hotel.subscription_expiry ?
        Math.max(0, Math.ceil((new Date(hotel.subscription_expiry) - new Date()) / (1000 * 60 * 60 * 24))) :
        0;
    res.json({
        ...hotel,
        is_visible: visible,
        is_featured_active: featured,
        subscription_days_left: daysLeft
    });
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

        const rooms = await pool.query('SELECT * FROM rooms WHERE hotel_id = $1 AND is_available = TRUE', [id]);
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

// ===== MY BOOKINGS - SIMPLIFIED =====
app.get('/api/my-bookings', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.json({ unlocked_hotels: [], room_bookings: [], food_orders: [] });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const clientId = decoded.id;

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
        console.error('My bookings error:', error);
        res.json({ unlocked_hotels: [], room_bookings: [], food_orders: [] });
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

// ===== START SERVER =====
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`👤 Admin: admin@hotelbooking.com / admin123`);
});
