const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const port = 5000;

// Increase payload size for photos
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors({ origin: '*' }));

// ===== IN-MEMORY DATABASE =====
let users = [];
let hotels = [];
let rooms = [];
let conferenceRooms = [];
let conferenceBookings = [];
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

// Register (public)
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

// Dashboard stats
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

// Get all hotels
app.get('/api/admin/hotels', isAdmin, (req, res) => {
    const list = hotels.map(h => ({
        ...h,
        owner_email: users.find(u => u.id === h.user_id)?.email || 'Unknown',
        room_count: rooms.filter(r => r.hotel_id === h.id).length,
        photo_url: h.photos && h.photos.length > 0 ? h.photos[0] : null
    }));
    res.json(list);
});

// Get single hotel
app.get('/api/admin/hotels/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const hotel = hotels.find(h => h.id === id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    res.json(hotel);
});

// ✅ CREATE HOTEL (with photos)
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

    // Find or create owner
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

// Update hotel
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

// Delete hotel
app.delete('/api/admin/hotels/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const index = hotels.findIndex(h => h.id === id);
    if (index === -1) return res.status(404).json({ error: 'Hotel not found' });
    hotels.splice(index, 1);
    rooms = rooms.filter(r => r.hotel_id !== id);
    conferenceRooms = conferenceRooms.filter(c => c.hotel_id !== id);
    res.json({ message: 'Deleted' });
});

// Get all users
app.get('/api/admin/users', isAdmin, (req, res) => {
    res.json(users.map(u => ({ id: u.id, email: u.email, user_type: u.user_type, full_name: u.full_name })));
});

// ===== HOTEL OWNER ROUTES =====

// Get owner's hotel
app.get('/api/hotels/me', isHotelOwner, (req, res) => {
    res.json(req.hotel);
});

// Update owner's hotel
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

// Upload photos
app.post('/api/hotels/me/photos', isHotelOwner, (req, res) => {
    const { photos } = req.body;
    if (photos && photos.length > 5) {
        return res.status(400).json({ error: 'Maximum 5 photos allowed' });
    }
    req.hotel.photos = photos || [];
    res.json({ message: 'Photos updated', photos: req.hotel.photos });
});

// Add room type
app.post('/api/rooms', isHotelOwner, (req, res) => {
    const { roomTypeName, capacity, basePricePerNight, totalRooms } = req.body;
    const newRoom = {
        id: nextId++,
        hotel_id: req.hotel.id,
        room_type_name: roomTypeName,
        capacity,
        base_price_per_night: basePricePerNight,
        total_rooms: totalRooms,
        created_at: new Date().toISOString()
    };
    rooms.push(newRoom);
    res.status(201).json(newRoom);
});

// Get rooms
app.get('/api/rooms/hotel/:hotelId', (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    res.json(rooms.filter(r => r.hotel_id === hotelId));
});

// Add conference room
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

// Get conference rooms
app.get('/api/conference/hotel/:hotelId', (req, res) => {
    const hotelId = parseInt(req.params.hotelId);
    res.json(conferenceRooms.filter(c => c.hotel_id === hotelId));
});

// Book conference room
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

// Get availability
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

// ===== START SERVER =====
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`👤 Admin: admin@hotelbooking.com / admin123`);
});
