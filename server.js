const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const port = 5000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Fake database (in memory)
let users = [];
let hotels = [];
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

// ===== ADMIN ROUTES =====
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

app.get('/api/admin/stats', isAdmin, (req, res) => {
    res.json({
        totalHotels: hotels.length,
        totalUsers: users.filter(u => u.user_type !== 'admin').length,
        totalRooms: 0,
        totalPhotos: 0,
        recentHotels: hotels.slice(-5).reverse()
    });
});

app.get('/api/admin/hotels', isAdmin, (req, res) => {
    const list = hotels.map(h => ({ ...h, owner_email: 'owner@example.com', room_count: 0, photo_url: null }));
    res.json(list);
});

app.post('/api/admin/hotels', isAdmin, (req, res) => {
    const { hotelName, ownerEmail, city, country, description, starRating, isActive } = req.body;
    const newHotel = {
        id: nextId++,
        hotel_name: hotelName,
        city,
        country,
        description,
        star_rating: starRating || 3,
        is_active: isActive !== undefined ? isActive : true,
        created_at: new Date().toISOString()
    };
    hotels.push(newHotel);
    res.status(201).json(newHotel);
});

app.put('/api/admin/hotels/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const hotel = hotels.find(h => h.id === id);
    if (!hotel) return res.status(404).json({ error: 'Not found' });
    Object.assign(hotel, req.body);
    res.json(hotel);
});

app.delete('/api/admin/hotels/:id', isAdmin, (req, res) => {
    const id = parseInt(req.params.id);
    const index = hotels.findIndex(h => h.id === id);
    if (index === -1) return res.status(404).json({ error: 'Not found' });
    hotels.splice(index, 1);
    res.json({ message: 'Deleted' });
});

app.get('/api/admin/users', isAdmin, (req, res) => {
    res.json(users.map(u => ({ id: u.id, email: u.email, user_type: u.user_type, full_name: u.full_name })));
});

app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));
