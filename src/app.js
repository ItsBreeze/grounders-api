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

require('./services/notifications');

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests — try again in 15 minutes' },
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

app.use('/auth',                     otpLimiter, authRoutes);
app.use('/users',                    userRoutes);
app.use('/posts',                    postRoutes);
app.use('/posts/:postId/reactions',  reactionRoutes);
app.use('/posts',                    reportRoutes);
app.use('/friends',                  friendRoutes);
app.use('/zones',                    zoneRoutes);
app.use('/upload-url',               uploadRoutes);
app.use('/devices',                  deviceRoutes);
app.use('/',                         blockRoutes);

app.use('/users/:userId/posts', (req, res, next) => {
  req.params.userId = req.params.userId;
  next();
}, postRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use(errorHandler);

module.exports = app;
