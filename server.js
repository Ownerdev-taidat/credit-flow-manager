require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const usePg = !!process.env.DATABASE_URL;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Trust proxy for Railway/Render
if (isProd) app.set('trust proxy', 1);

// Session config
// In production behind Cloudflare/Railway proxy, use 'auto' secure detection
// secure: 'auto' means Express will check req.protocol (trust proxy must be set)
const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'credit-flow-default-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: isProd ? 'auto' : false,
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    }
};

// Use PG session store for production, memory store for local dev
if (usePg && db.pool) {
    const pgSession = require('connect-pg-simple')(session);
    sessionConfig.store = new pgSession({ pool: db.pool, tableName: 'session', createTableIfMissing: true });
}

app.use(session(sessionConfig));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admins', require('./routes/admins'));
app.use('/api/members', require('./routes/members'));
app.use('/api/credits', require('./routes/credits'));
app.use('/api/storage', require('./routes/storage'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/super-admin', require('./routes/superadmin'));

// Global JSON error handler for API routes
app.use('/api', (err, req, res, next) => {
    console.error(`[API Error] ${req.method} ${req.url}:`, err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

// Super Admin dashboard
app.get('/super-admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'super-admin.html'));
});

// SPA catch-all (only for non-API routes)
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize DB then start server
db.init().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Credit-Flow Manager running on http://localhost:${PORT}`);

        // Start auto sync (requires Chrome — only on VPS, skip on Railway)
        const hasChromeForSync = (() => {
            const fs = require('fs');
            const { execSync } = require('child_process');
            const paths = [process.env.CHROME_BIN, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'].filter(Boolean);
            for (const p of paths) { if (fs.existsSync(p)) return true; }
            try { execSync('which google-chrome || which chromium-browser || which chromium', { stdio: 'ignore' }); return true; } catch { }
            try { execSync('where chrome', { stdio: 'ignore' }); return true; } catch { }
            return false;
        })();
        if (hasChromeForSync) {
            try {
                const { startAutoSync } = require('./services/scraper');
                startAutoSync();
                console.log('[Scraper] ✅ Chrome found — auto-sync enabled');
            } catch (err) {
                console.log('[Scraper] ⚠️ Scraper load failed:', err.message);
            }
        } else {
            console.log('[Scraper] ⏭ Chrome not found (Railway) — auto-sync disabled, using VPS bridge');
        }

        // Start MB Bank service
        try {
            const { startAutoCheck } = require('./services/mbbank');
            startAutoCheck();
        } catch (err) {
            console.log('[MBBank] ⚠️ Start error:', err.message);
        }
    });
}).catch(err => {
    console.error('❌ Failed to initialize database:', err.message);
    process.exit(1);
});
