require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced middleware setup
app.use(cors({
    origin: process.env.FRONTEND_URL || `http://localhost:${PORT}`,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
}));
app.use(express.json({ limit: '10mb' }));

// MySQL connection with retry logic
const createPool = () => mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'face_recognition',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    namedPlaceholders: true
});

let pool;
const initializePool = async () => {
    pool = createPool();
    let retries = 5;
    while (retries > 0) {
        try {
            const conn = await pool.getConnection();
            console.log('✅ Database connection established');
            conn.release();
            return;
        } catch (err) {
            retries--;
            console.error(`Database connection failed (${retries} retries left):`, err.message);
            await new Promise(res => setTimeout(res, 5000));
        }
    }
    throw new Error('Failed to connect to database after retries');
};

// Descriptor validation
const validateFaceDescriptor = (descriptor) => {
    if (!descriptor) return false;
    try {
        const parsed = typeof descriptor === 'string' ? JSON.parse(descriptor) : descriptor;
        return Array.isArray(parsed) && parsed.length === 128 && 
               parsed.every(num => typeof num === 'number');
    } catch (e) {
        return false;
    }
};

// API Routes
app.get('/api/health', (_, res) => res.json({ status: 'healthy' }));

// Users API
app.get('/api/users', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                id, name, \`rank\`, idCard, phone, unit, 
                photo, 
                IF(descriptor IS NOT NULL, TRUE, FALSE) AS has_descriptor
            FROM users
        `);

        res.json(rows.map(user => ({
            ...user,
            descriptor: null // Don't send full descriptor for listing
        })));
    } catch (err) {
        console.error('GET /users error:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

app.get('/api/users/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT * FROM users WHERE id = ?
        `, [req.params.id]);

        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const user = rows[0];
        if (!validateFaceDescriptor(user.descriptor)) {
            console.warn(`Invalid descriptor for user ${user.id}`);
            user.descriptor = null;
        }

        res.json(user);
    } catch (err) {
        console.error('GET /users/:id error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/users', async (req, res) => {
    const { id, name, photo, descriptor } = req.body;
    if (!id || !name || !photo) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (descriptor && !validateFaceDescriptor(descriptor)) {
        return res.status(400).json({ error: 'Invalid face descriptor format' });
    }

    try {
        await pool.query(`
            INSERT INTO users 
            (id, name, \`rank\`, idCard, phone, unit, photo, descriptor)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id,
            name,
            req.body.rank || null,
            req.body.idCard || null,
            req.body.phone || null,
            req.body.unit || null,
            photo,
            descriptor ? JSON.stringify(descriptor) : null
        ]);

        res.status(201).json({ message: 'User created' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'User ID already exists' });
        }
        console.error('POST /users error:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

// Update user endpoint
app.put('/api/users/:id', async (req, res) => {
    const { name, rank, idCard, phone, unit, photo, descriptor } = req.body;
    
    if (descriptor && !validateFaceDescriptor(descriptor)) {
        return res.status(400).json({ error: 'Invalid face descriptor format' });
    }

    try {
        const [result] = await pool.query(`
            UPDATE users SET 
                name = COALESCE(?, name),
                \`rank\` = COALESCE(?, \`rank\`),
                idCard = COALESCE(?, idCard),
                phone = COALESCE(?, phone),
                unit = COALESCE(?, unit),
                photo = COALESCE(?, photo),
                descriptor = COALESCE(?, descriptor)
            WHERE id = ?
        `, [
            name, rank, idCard, phone, unit, photo, 
            descriptor ? JSON.stringify(descriptor) : null,
            req.params.id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ message: 'User updated successfully' });
    } catch (err) {
        console.error('PUT /users/:id error:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

// Delete user endpoint
app.delete('/api/users/:id', async (req, res) => {
    try {
        const [result] = await pool.query(`
            DELETE FROM users WHERE id = ?
        `, [req.params.id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ message: 'User deleted successfully' });
    } catch (err) {
        console.error('DELETE /users/:id error:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

// Logs API
app.get('/api/logs', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                log_id, 
                DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
                user_id,
                user_name,
                status
            FROM logs
            ORDER BY timestamp DESC
            LIMIT 100
        `);
        res.json(rows);
    } catch (err) {
        console.error('GET /logs error:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

app.post('/api/logs', async (req, res) => {
    const { userId, userName, status } = req.body;
    
    if (!userId || !userName || !status) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        await pool.query(`
            INSERT INTO logs (user_id, user_name, status)
            VALUES (?, ?, ?)
        `, [userId, userName, status]);

        res.status(201).json({ message: 'Log created' });
    } catch (err) {
        console.error('POST /logs error:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

// Static files and error handling
app.use(express.static(path.join(__dirname,'..', 'frontend')));


app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Startup with browser auto-open
initializePool().then(() => {
    const server = app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`🔌 Connected to MySQL at ${process.env.DB_HOST || 'localhost'}`);

        // Auto-open browser
        const url = `http://localhost:${PORT}/login.html`;
        const openCommand = process.platform === 'win32' 
            ? `start "" "${url}"` 
            : process.platform === 'darwin' 
                ? `open "${url}"` 
                : `xdg-open "${url}"`;

        exec(openCommand, (error) => {
            if (error) {
                console.log(`⚠️ Could not auto-open browser. Please visit: ${url}`);
            } else {
                console.log('✔ Browser opened automatically');
            }
        });
    });

    // Handle server errors
    server.on('error', (err) => {
        console.error('Server error:', err);
        process.exit(1);
    });
}).catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});