const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const port = 5000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors({ origin: '*' }));

// ===== IN-MEMORY DATABASE =====
let users = [];
let hotels = [];
let rooms = [];
let conferenceRooms = [];
let conferenceBookings = [];
let payments = []; // track paid clients
let reviews = []; // user reviews
let subscriptions = []; // track hotel subscriptions
let nextId = 1;

// Create default admin
const salt = bcrypt.genSaltSync(10);
users.push({
    id: 1,
    email: 'admin@hotelbooking.com',
    password_hash: bcrypt.hashSync('admin123', salt),
    user_type: 'admin',
    full_name: 'Super Admin'
});

// ===== HELPER FUNCTIONS =====
function isHotelVisible(hotel) {
    if (!hotel.is_active) return false;
    if (!hotel.subscription_expiry) return false;
    return new Date(hotel.subscription_expiry) > new Date();
}

function isHotelFeatured(hotel) {
    if (!hotel.is_featured) return false;
    if (!hotel.featured_expiry) return false;
    return new Date(hotel.featured_expiry) > new Date();
}

// ===== AUTH =====
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, userType: user.user_type }, 'secret', { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, userType: user.user_type, full_name: user.full_name } });
});

app.post('/api/auth/register', async (req, res) => {
    const { email, password, userType, companyName, fullName } = req.body;
    if (users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'Email already registered' });
    }
    const hashedPassword = bcrypt.hashSync(password, 10);
    const newUser = {
        id: nextId++,
        email,
        password_hash: hashedPassword,
        user_type: userType,
        company_name: companyName || null,
        full_name: fullName || null
    };
    users.push(newUser);
    const token = jwt.sign({ id: newUser.id, userType: newUser.user_type }, 'secret', { expiresIn: '7d' });
    res.json({ token, user: { id: newUser.id, email: newUser.email, userType: newUser.user_type, full_name: newUser.full_name } });
});

// ===== MIDDLEWARE =====
const isAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        const decoded = jwt.verify(token, 'secret');
        if (decoded.userType !== 'admin') return res.status(403).json({ error: 'Admin only' });
        req.userId = decoded.id;
        next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
};

const isHotelOwner = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        const decoded = jwt.verify(token, 'secret');
        if (decoded.userType !== 'hotel') return res.status(403).json({ error: 'Hotel owner only' });
        req.userId = decoded.id;
        const hotel = hotels.find(h => h.user_id === decoded.id);
        if (!hotel) return res.status(404).json({ error: 'No hotel found' });
        req.hotel = hotel;
        next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ===== ADMIN ROUTES =====
app.get('/api/admin/stats', isAdmin, (req, res) => {
    const totalPhotos = hotels.reduce((acc, h) => acc + (h.photos ? h.photos.length : 0), 0);
    res.json({
        totalHotels: hotels.length,
        totalUsers: users.filter(u => u.user_type !== 'admin').length,
        totalRooms: rooms.length,
        totalPhotos: totalPhotos,
        totalReviews: reviews.length,
        recentHotels: hotels.slice(-5).reverse()
    });
});

app.get('/api/admin/hotels', isAdmin, (req, res) => {
    const list = hotels.map(h => ({
        ...h,
        owner_email: users.find(u => u.id === h.user_id)?.email || 'Unknown',
        room_count: rooms.filter(r => r.hotel_id === h.id).length,
        photo_url: h.photos && h.photos.length > 0 ? h.photos[0] : null,
        is_visible: isHotelVisible(h),
        is_featured_active: isHotelFeatured(h)
    }));
    res.json(list);
});

app.get('/api/admin/hotels/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const hotel = hotels.find(h => h.id === id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    res.json(hotel);
});

app.post('/api/admin/hotels', isAdmin, (req, res) => {
    const { 
        hotelName, 
        ownerEmail, 
        phone,
        city, 
        country, 
        address,
        description, 
        starRating, 
        isActive,
        photos
    } = req.body;

    if (photos && photos.length > 5) {
        return res.status(400).json({ error: 'Maximum 5 photos allowed' });
    }

    let owner = users.find(u => u.email === ownerEmail && u.user_type === 'hotel');
    let userId;
    if (owner) {
        userId = owner.id;
    } else {
        const tempPassword = Math.random().toString(36).slice(-8);
        const hashedPassword = bcrypt.hashSync(tempPassword, 10);
        const newUser = {
            id: nextId++,
            email: ownerEmail,
            password_hash: hashedPassword,
            user_type: 'hotel',
            company_name: hotelName,
            full_name: hotelName
        };
        users.push(newUser);
        userId = newUser.id;
        console.log(`🆕 Created owner: ${ownerEmail}, password: ${tempPassword}`);
    }

    // Set initial subscription to 30 days from now
    const subscriptionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const newHotel = {
        id: nextId++,
        user_id: userId,
        hotel_name: hotelName,
        phone: phone || '',
        city,
        country,
        address: address || '',
        description: description || '',
        star_rating: starRating || 3,
        is_active: isActive !== undefined ? isActive : true,
        photos: photos || [],
        subscription_expiry: subscriptionExpiry.toISOString(),
        is_featured: false,
        featured_expiry: null,
        created_at: new Date().toISOString()
    };
    hotels.push(newHotel);
    res.status(201).json(newHotel);
});

app.put('/api/admin/hotels/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const hotel = hotels.find(h => h.id === id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    const { hotelName, phone, city, country, address, description, starRating, isActive } = req.body;
    if (hotelName !== undefined) hotel.hotel_name = hotelName;
    if (phone !== undefined) hotel.phone = phone;
    if (city !== undefined) hotel.city = city;
    if (country !== undefined) hotel.country = country;
    if (address !== undefined) hotel.address = address;
    if (description !== undefined) hotel.description = description;
    if (starRating !== undefined) hotel.star_rating = starRating;
    if (isActive !== undefined) hotel.is_active = isActive;
    res.json(hotel);
});

app.delete('/api/admin/hotels/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const index = hotels.findIndex(h => h.id === id);
    if (index === -1) return res.status(404).json({ error: 'Hotel not found' });
    hotels.splice(index, 1);
    rooms = rooms.filter(r => r.hotel_id !== id);
    conferenceRooms = conferenceRooms.filter(c => c.hotel_id !== id);
    res.json({ message: 'Deleted' });
});

app.get('/api/admin/users', isAdmin, (req, res) => {
    res.json(users.map(u => ({ id: u.id, email: u.email, user_type: u.user_type, full_name: u.full_name })));
});

// ===== HOTEL OWNER ROUTES =====
app.get('/api/hotels/me', isHotelOwner, (req, res) => {
    const hotel = req.hotel;
    res.json({
        ...hotel,
        is_visible: isHotelVisible(hotel),
        is_featured_active: isHotelFeatured(hotel),
        subscription_days_left: hotel.subscription_expiry ? 
            Math.max(0, Math.ceil((new Date(hotel.subscription_expiry) - new Date()) / (1000 * 60 * 60 * 24))) : 0
    });
});

app.put('/api/hotels/me', isHotelOwner, (req, res) => {
    const { hotelName, phone, city, country, address, description, starRating } = req.body;
    const hotel = req.hotel;
    if (hotelName !== undefined) hotel.hotel_name = hotelName;
    if (phone !== undefined) hotel.phone = phone;
    if (city !== undefined) hotel.city = city;
    if (country !== undefined) hotel.country = country;
    if (address !== undefined) hotel.address = address;
    if (description !== undefined) hotel.description = description;
    if (starRating !== undefined) hotel.star_rating = starRating;
    res.json(hotel);
});

app.post('/api/hotels/me/photos', isHotelOwner, (req, res) => {
    const { photos } = req.body;
    if (photos && photos.length > 5) {
        return res.status(400).json({ error: 'Maximum 5 photos allowed' });
    }
    req.hotel.photos = photos || [];
    res.json({ message: 'Photos updated', photos: req.hotel.photos });
});

// ===== SUBSCRIPTION ROUTES =====
app.post('/api/payments/subscribe', isHotelOwner, async (req, res) => {
    const { amount, paymentMethod } = req.body; // amount: 1000 or 5000
    const hotel = req.hotel;

    try {
        // In production: Verify payment via M-Pesa Daraja API or other gateway
        // For now, we simulate success

        const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        
        if (amount === 1000) {
            // Basic subscription - 30 days visibility
            hotel.subscription_expiry = expiryDate.toISOString();
            subscriptions.push({
                id: nextId++,
                hotel_id: hotel.id,
                amount: 1000,
                type: 'subscription',
                payment_method: paymentMethod || 'mpesa',
                created_at: new Date().toISOString(),
                expires_at: expiryDate.toISOString()
            });
            res.json({ 
                success: true, 
                message: '✅ Subscription activated for 30 days!',
                expiry: expiryDate.toISOString()
            });
        } else if (amount === 5000) {
            // Featured subscription - 30 days visibility + featured
            hotel.subscription_expiry = expiryDate.toISOString();
            hotel.is_featured = true;
            hotel.featured_expiry = expiryDate.toISOString();
            subscriptions.push({
                id: nextId++,
                hotel_id: hotel.id,
                amount: 5000,
                type: 'featured',
                payment_method: paymentMethod || 'mpesa',
                created_at: new Date().toISOString(),
                expires_at: expiryDate.toISOString()
            });
            res.json({ 
                success: true, 
                message: '✅ Featured subscription activated for 30 days!',
                expiry: expiryDate.toISOString()
            });
        } else {
            res.status(400).json({ error: 'Invalid subscription amount' });
        }
    } catch (error) {
        console.error('Subscription error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== ROOMS =====
app.post('/api/rooms', isHotelOwner, (req, res) => {
    const { roomTypeName, capacity, basePricePerNight, totalRooms } = req.body;
    const newRoom = {
        id: nextId++,
        hotel_id: req.hotel.id,
        room_type_name: roomTypeName,
        capacity,
        base_price_per_night: basePricePerNight,
        total_rooms: totalRooms,
        is_available: true,
        created_at: new Date().toISOString()
    };
    rooms.push(newRoom);
    res.status(201).json(newRoom);
});

app.get('/api/rooms/hotel/:hotelId', (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    res.json(rooms.filter(r => r.hotel_id === hotelId));
});

app.put('/api/rooms/:id/toggle', isHotelOwner, (req, res) => {
    const id = parseInt(req.params.id);
    const room = rooms.find(r => r.id === id && r.hotel_id === req.hotel.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    room.is_available = req.body.is_available !== undefined ? req.body.is_available : true;
    res.json(room);
});

app.put('/api/rooms/:id', isHotelOwner, (req, res) => {
    const id = parseInt(req.params.id);
    const room = rooms.find(r => r.id === id && r.hotel_id === req.hotel.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const { room_type_name, capacity, base_price_per_night, total_rooms } = req.body;
    if (room_type_name !== undefined) room.room_type_name = room_type_name;
    if (capacity !== undefined) room.capacity = capacity;
    if (base_price_per_night !== undefined) room.base_price_per_night = base_price_per_night;
    if (total_rooms !== undefined) room.total_rooms = total_rooms;
    res.json(room);
});

app.delete('/api/rooms/:id', isHotelOwner, (req, res) => {
    const id = parseInt(req.params.id);
    const index = rooms.findIndex(r => r.id === id && r.hotel_id === req.hotel.id);
    if (index === -1) return res.status(404).json({ error: 'Room not found' });
    rooms.splice(index, 1);
    res.json({ message: 'Deleted' });
});

// ===== CONFERENCE =====
app.post('/api/conference', isHotelOwner, (req, res) => {
    const { roomName, capacity, pricePerHour } = req.body;
    const newConf = {
        id: nextId++,
        hotel_id: req.hotel.id,
        room_name: roomName,
        capacity,
        price_per_hour: pricePerHour,
        is_available: true,
        created_at: new Date().toISOString()
    };
    conferenceRooms.push(newConf);
    res.status(201).json(newConf);
});

app.get('/api/conference/hotel/:hotelId', (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    res.json(conferenceRooms.filter(c => c.hotel_id === hotelId));
});

app.post('/api/conference/bookings', isHotelOwner, (req, res) => {
    const { conferenceRoomId, bookingDate, startTime, endTime, purpose } = req.body;
    const confRoom = conferenceRooms.find(c => c.id === conferenceRoomId && c.hotel_id === req.hotel.id);
    if (!confRoom) return res.status(404).json({ error: 'Conference room not found' });
    
    const conflict = conferenceBookings.find(b =>
        b.conference_room_id === conferenceRoomId &&
        b.booking_date === bookingDate &&
        b.status === 'confirmed' &&
        ((startTime >= b.start_time && startTime < b.end_time) ||
         (endTime > b.start_time && endTime <= b.end_time))
    );
    if (conflict) return res.status(400).json({ error: 'Time slot already booked' });
    
    const newBooking = {
        id: nextId++,
        conference_room_id: conferenceRoomId,
        booked_by: req.userId,
        booking_date: bookingDate,
        start_time: startTime,
        end_time: endTime,
        purpose: purpose || '',
        status: 'confirmed',
        created_at: new Date().toISOString()
    };
    conferenceBookings.push(newBooking);
    res.status(201).json(newBooking);
});

app.get('/api/conference/hotel/:hotelId/availability', (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    const confs = conferenceRooms.filter(c => c.hotel_id === hotelId);
    const result = confs.map(c => ({
        ...c,
        bookings: conferenceBookings
            .filter(b => b.conference_room_id === c.id && b.status === 'confirmed')
            .map(b => ({ date: b.booking_date, start: b.start_time, end: b.end_time }))
    }));
    res.json(result);
});

// ===== PUBLIC ROUTES =====

// List all hotels (public) – only visible hotels
app.get('/api/hotels/public', (req, res) => {
    const visibleHotels = hotels.filter(h => isHotelVisible(h) && h.is_active);
    const publicHotels = visibleHotels.map(h => ({
        id: h.id,
        hotel_name: h.hotel_name,
        city: h.city,
        country: h.country,
        star_rating: h.star_rating,
        description: h.description,
        photos: h.photos || [],
        is_featured: isHotelFeatured(h),
        room_types: rooms.filter(r => r.hotel_id === h.id).map(r => ({
            id: r.id,
            name: r.room_type_name,
            capacity: r.capacity,
            price_per_night: r.base_price_per_night,
            total_rooms: r.total_rooms,
            is_available: r.is_available !== false
        })),
        conference_rooms: conferenceRooms.filter(c => c.hotel_id === h.id).map(c => ({
            id: c.id,
            name: c.room_name,
            capacity: c.capacity,
            price_per_hour: c.price_per_hour
        }))
    }));
    res.json(publicHotels);
});

// Get featured hotels
app.get('/api/hotels/featured', (req, res) => {
    const featuredHotels = hotels.filter(h => isHotelVisible(h) && isHotelFeatured(h) && h.is_active);
    const result = featuredHotels.map(h => ({
        id: h.id,
        hotel_name: h.hotel_name,
        city: h.city,
        country: h.country,
        star_rating: h.star_rating,
        description: h.description,
        photos: h.photos || [],
        room_types: rooms.filter(r => r.hotel_id === h.id).map(r => ({
            id: r.id,
            name: r.room_type_name,
            capacity: r.capacity,
            price_per_night: r.base_price_per_night,
            total_rooms: r.total_rooms,
            is_available: r.is_available !== false
        }))
    }));
    res.json(result);
});

// Get single hotel details – hides contacts unless paid
app.get('/api/hotels/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const hotel = hotels.find(h => h.id === id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

    // Check if hotel is visible
    if (!isHotelVisible(hotel) || !hotel.is_active) {
        return res.status(403).json({ error: 'Hotel is currently unavailable' });
    }

    let hasAccess = false;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
        try {
            const decoded = jwt.verify(token, 'secret');
            const clientId = decoded.id;
            const payment = payments.find(p => 
                p.client_id === clientId && 
                p.hotel_id === id && 
                p.paid === true &&
                new Date(p.expires_at) > new Date()
            );
            if (payment) hasAccess = true;
        } catch (e) { /* ignore */ }
    }

    // Get reviews for this hotel
    const hotelReviews = reviews.filter(r => r.hotel_id === id).sort((a, b) => 
        new Date(b.created_at) - new Date(a.created_at)
    );

    const response = {
        id: hotel.id,
        hotel_name: hotel.hotel_name,
        city: hotel.city,
        country: hotel.country,
        address: hasAccess ? hotel.address : null,
        phone: hasAccess ? hotel.phone : null,
        email: hasAccess ? users.find(u => u.id === hotel.user_id)?.email : null,
        star_rating: hotel.star_rating,
        description: hotel.description,
        photos: hotel.photos || [],
        is_featured: isHotelFeatured(hotel),
        room_types: rooms.filter(r => r.hotel_id === hotel.id).map(r => ({
            id: r.id,
            name: r.room_type_name,
            capacity: r.capacity,
            price_per_night: hasAccess ? r.base_price_per_night : null,
            total_rooms: r.total_rooms,
            is_available: r.is_available !== false
        })),
        conference_rooms: conferenceRooms.filter(c => c.hotel_id === hotel.id).map(c => ({
            id: c.id,
            name: c.room_name,
            capacity: c.capacity,
            price_per_hour: hasAccess ? c.price_per_hour : null
        })),
        reviews: hotelReviews.map(r => ({
            id: r.id,
            user_name: r.user_name,
            rating: r.rating,
            comment: r.comment,
            created_at: r.created_at
        })),
        hasAccess: hasAccess,
        unlockPrice: 100 // KES
    };
    res.json(response);
});

// ===== REVIEWS =====
app.post('/api/reviews', async (req, res) => {
    const { hotel_id, rating, comment } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Please login to post a review' });

    try {
        const decoded = jwt.verify(token, 'secret');
        const userId = decoded.id;
        const user = users.find(u => u.id === userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const hotel = hotels.find(h => h.id === parseInt(hotel_id));
        if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

        const newReview = {
            id: nextId++,
            hotel_id: parseInt(hotel_id),
            user_id: userId,
            user_name: user.full_name || user.email,
            rating: Math.min(5, Math.max(1, parseInt(rating))),
            comment: comment || '',
            created_at: new Date().toISOString()
        };
        reviews.push(newReview);
        res.status(201).json(newReview);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== PAYMENT ROUTES =====
const UNLOCK_PRICE_KES = 100;

// M-PESA Payment for client unlock
app.post('/api/payments/mpesa/confirm', async (req, res) => {
    const { hotel_id, phone_number, till_number, amount } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not logged in' });

    try {
        const decoded = jwt.verify(token, 'secret');
        const clientId = decoded.id;

        // In production: Verify M-Pesa payment via Safaricom Daraja API
        // For now, we simulate success

        let payment = payments.find(p => 
            p.client_id === clientId && 
            p.hotel_id === parseInt(hotel_id)
        );

        if (payment) {
            payment.paid = true;
            payment.expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        } else {
            payments.push({
                client_id: clientId,
                hotel_id: parseInt(hotel_id),
                paid: true,
                session_id: 'mpesa_' + Date.now(),
                expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                amount: UNLOCK_PRICE_KES
            });
        }

        res.json({ success: true, message: 'M-Pesa payment confirmed' });
    } catch (error) {
        console.error('M-Pesa confirm error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Card Payment for client unlock
app.post('/api/payments/card/confirm', async (req, res) => {
    const { hotel_id, card_last4, amount } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not logged in' });

    try {
        const decoded = jwt.verify(token, 'secret');
        const clientId = decoded.id;

        let payment = payments.find(p => 
            p.client_id === clientId && 
            p.hotel_id === parseInt(hotel_id)
        );

        if (payment) {
            payment.paid = true;
            payment.expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        } else {
            payments.push({
                client_id: clientId,
                hotel_id: parseInt(hotel_id),
                paid: true,
                session_id: 'card_' + Date.now(),
                expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                amount: UNLOCK_PRICE_KES
            });
        }

        res.json({ success: true, message: 'Card payment confirmed' });
    } catch (error) {
        console.error('Card confirm error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Check access for a hotel
app.get('/api/hotels/:id/access', async (req, res) => {
    const hotelId = parseInt(req.params.id);
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ hasAccess: false });

    try {
        const decoded = jwt.verify(token, 'secret');
        const clientId = decoded.id;
        const payment = payments.find(p =>
            p.client_id === clientId &&
            p.hotel_id === hotelId &&
            p.paid === true &&
            new Date(p.expires_at) > new Date()
        );
        res.json({ hasAccess: !!payment });
    } catch (e) {
        res.json({ hasAccess: false });
    }
});

// ===== START SERVER =====
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`👤 Admin: admin@hotelbooking.com / admin123`);
    console.log(`💰 Client unlock price: ${UNLOCK_PRICE_KES} KES`);
});
