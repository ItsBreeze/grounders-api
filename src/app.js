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
const gmailLinkRoutes    = require('./routes/gmail_link');
const { router: mcpRoutes } = require('./routes/mcp');
const mcpOauth              = require('./services/mcp_oauth');

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

// The MCP endpoint carries a whole Claude session's tool calls and would trip
// the 120/min app limit mid-conversation; it gets its own headroom below.
app.use((req, res, next) => (req.path.startsWith('/mcp') ? next() : generalLimiter(req, res, next)));

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

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
app.use('/radio',                    radioRoutes);
app.use('/invites',                  inviteRoutes);

// ─── Gmail multi-account MCP connector ──────────────────────────────────────
// RFC 9728 / RFC 8414 discovery. Clients probe both the bare path and the
// resource-path-suffixed form, so serve both.
const oauthMetadata = (build) => (req, res, next) => {
  try { res.json(build()); } catch (err) { next(err); }
};

app.get('/.well-known/oauth-protected-resource',
  oauthMetadata(() => mcpOauth.protectedResourceMetadata()));
app.get('/.well-known/oauth-protected-resource/mcp',
  oauthMetadata(() => mcpOauth.protectedResourceMetadata()));
app.get('/.well-known/oauth-authorization-server',
  oauthMetadata(() => mcpOauth.authorizationServerMetadata()));
app.get('/.well-known/oauth-authorization-server/mcp',
  oauthMetadata(() => mcpOauth.authorizationServerMetadata()));

app.use('/mcp',                      mcpLimiter, mcpRoutes);
app.use('/gmail',                    gmailLinkRoutes);
app.use('/',                         blockRoutes);

app.use('/users/:userId/posts', (req, res, next) => {
  req.params.userId = req.params.userId;
  next();
}, postRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use(errorHandler);

module.exports = app;
