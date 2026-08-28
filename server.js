const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');

// ===== IMPORTANT: Replace with your Stripe secret key (if using Stripe) =====
// If you're only using M-Pesa and card (simulated), you can leave this as is.
const stripe = Stripe('sk_test_...'); // <-- PASTE YOUR STRIPE SECRET KEY HERE

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
        recentHotels: hotels.slice(-5).reverse()
    });
});

app.get('/api/admin/hotels', isAdmin, (req, res) => {
    const list = hotels.map(h => ({
        ...h,
        owner_email: users.find(u => u.id === h.user_id)?.email || 'Unknown',
        room_count: rooms.filter(r => r.hotel_id === h.id).length,
        photo_url: h.photos && h.photos.length > 0 ? h.photos[0] : null
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
    res.json(req.hotel);
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

app.post('/api/rooms', isHotelOwner, (req, res) => {
    const { roomTypeName, capacity, basePricePerNight, totalRooms } = req.body;
    const newRoom = {
        id: nextId++,
        hotel_id: req.hotel.id,
        room_type_name: roomTypeName,
        capacity,
        base_price_per_night: basePricePerNight,
        total_rooms: totalRooms,
        is_available: true, // by default available
        created_at: new Date().toISOString()
    };
    rooms.push(newRoom);
    res.status(201).json(newRoom);
});

app.get('/api/rooms/hotel/:hotelId', (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    res.json(rooms.filter(r => r.hotel_id === hotelId));
});

// Toggle room availability (new endpoint)
app.put('/api/rooms/:id/toggle', isHotelOwner, (req, res) => {
    const id = parseInt(req.params.id);
    const room = rooms.find(r => r.id === id && r.hotel_id === req.hotel.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    room.is_available = req.body.is_available !== undefined ? req.body.is_available : true;
    res.json(room);
});

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

// List all hotels (public) – no contact details
app.get('/api/hotels/public', (req, res) => {
    const publicHotels = hotels.map(h => ({
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

// Get single hotel details (public) – hides contacts unless paid
app.get('/api/hotels/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const hotel = hotels.find(h => h.id === id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

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
        hasAccess: hasAccess,
        unlockPrice: 4.99
    };
    res.json(response);
});

// ===== PAYMENT ROUTES =====

// Stripe Checkout (keep if you want)
app.post('/api/payments/create-checkout-session', async (req, res) => {
    const { hotelId } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Please login first' });

    try {
        const decoded = jwt.verify(token, 'secret');
        const clientId = decoded.id;

        const hotel = hotels.find(h => h.id === parseInt(hotelId));
        if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `Unlock ${hotel.hotel_name} details`,
                        description: `Access phone, email and exact address for ${hotel.hotel_name}`,
                    },
                    unit_amount: 499,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${req.headers.origin}/hotel-detail.html?id=${hotelId}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.headers.origin}/hotel-detail.html?id=${hotelId}`,
            metadata: {
                client_id: clientId.toString(),
                hotel_id: hotelId.toString()
            }
        });

        res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Confirm Stripe payment
app.post('/api/payments/confirm', async (req, res) => {
    const { session_id, hotel_id } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not logged in' });

    try {
        const decoded = jwt.verify(token, 'secret');
        const clientId = decoded.id;

        const session = await stripe.checkout.sessions.retrieve(session_id);
        if (session.payment_status !== 'paid') {
            return res.status(400).json({ error: 'Payment not completed' });
        }

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
                session_id: session_id,
                expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            });
        }

        res.json({ success: true, message: 'Access granted' });
    } catch (error) {
        console.error('Confirm error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== M-PESA PAYMENT (Simulated) =====
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
                expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            });
        }

        res.json({ success: true, message: 'M-Pesa payment confirmed' });
    } catch (error) {
        console.error('M-Pesa confirm error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== CARD PAYMENT (Simulated) =====
app.post('/api/payments/card/confirm', async (req, res) => {
    const { hotel_id, card_last4, amount } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not logged in' });

    try {
        const decoded = jwt.verify(token, 'secret');
        const clientId = decoded.id;

        // In production: Verify card payment via payment gateway
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
                session_id: 'card_' + Date.now(),
                expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
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
});
