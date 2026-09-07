require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');

const { errorHandler } = require('./middleware/error');

const authRoutes     = require('./routes/auth');
const userRoutes     = require('./routes/users');
const postRoutes     = require('./routes/posts');
const reactionRoutes = require('./routes/reactions');
const friendRoutes   = require('./routes/friends');
const zoneRoutes     = require('./routes/zones');
const uploadRoutes   = require('./routes/uploads');
const deviceRoutes   = require('./routes/devices');
const blockRoutes    = require('./routes/blocks');
const reportRoutes   = require('./routes/reports');
const radioRoutes    = require('./routes/radio');
const inviteRoutes   = require('./routes/invites');

require('./services/notifications');

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

// Sending codes costs SMS money, so this one is tight. It guards
// /auth/request-otp only â€” see the mounts below.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests — try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Guessing codes is what this one limits, so only failed attempts count: a
// correct code is refunded, and a user who mistypes once, resends and then
// verifies has not spent the window.
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many verification attempts â€” try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Each auth step has its own bucket. /auth/refresh sits under generalLimiter
// alone: it runs on every app launch and must never be starved by a sign-in.
app.use('/auth/request-otp',         otpLimiter);
app.use('/auth/verify-otp',          verifyLimiter);
app.use('/auth',                     authRoutes);
app.use('/users',                    userRoutes);
app.use('/posts',                    postRoutes);
app.use('/posts/:postId/reactions',  reactionRoutes);
app.use('/posts',                    reportRoutes);
app.use('/friends',                  friendRoutes);
app.use('/zones',                    zoneRoutes);
app.use('/upload-url',               uploadRoutes);
app.use('/devices',                  deviceRoutes);
app.use('/radio',                    radioRoutes);
app.use('/invites',                  inviteRoutes);

app.use('/',                         blockRoutes);

app.use('/users/:userId/posts', (req, res, next) => {
  req.params.userId = req.params.userId;
  next();
}, postRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use(errorHandler);

module.exports = app;
