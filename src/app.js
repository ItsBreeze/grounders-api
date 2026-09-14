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
const radioCallRoutes = require('./routes/radio_call');
const inviteRoutes   = require('./routes/invites');
const mcpOauthRoutes = require('./routes/mcp_oauth');
const mcpRoutes      = require('./routes/mcp');
const partnerRoutes  = require('./routes/partner');

require('./services/notifications');

const app = express();

// Railway terminates TLS at its edge and forwards each request with a single
// X-Forwarded-For hop. Trusting exactly that hop makes req.ip the caller's
// address instead of the edge's, so the limiters below key per user rather
// than putting every user in one bucket. It must be a hop count, not `true`:
// `true` would let a caller pick its own key by sending the header itself,
// and express-rate-limit refuses it (ERR_ERL_PERMISSIVE_TRUST_PROXY).
app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

// Sending codes costs SMS money, so this one is tight. It guards
// /auth/request-otp only — see the mounts below.
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
  message: { error: 'Too many verification attempts — try again in 15 minutes' },
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
// Calls mount ABOVE /radio so /radio/calls/:id reaches this router rather
// than falling through radio.js, which has no such path but does own the
// prefix.
app.use('/radio/calls',              radioCallRoutes);
app.use('/radio',                    radioRoutes);
app.use('/invites',                  inviteRoutes);

// The MCP connector: Claude, ChatGPT and Gemini reach Grounders + Radio
// through here. Mounted at the root because OAuth discovery lives at fixed
// /.well-known paths that cannot be nested — and BEFORE blockRoutes, whose
// root-mounted requireAuth would otherwise answer these with the app's 401.
app.use('/',                         mcpOauthRoutes);
app.use('/',                         mcpRoutes);
// Offhand's built-in Grounders + Radio: a shared-key endpoint that issues the
// same connector tokens for a phone Offhand has already verified.
app.use('/',                         partnerRoutes);

app.use('/',                         blockRoutes);

app.use('/users/:userId/posts', (req, res, next) => {
  req.params.userId = req.params.userId;
  next();
}, postRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use(errorHandler);

module.exports = app;
