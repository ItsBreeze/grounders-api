const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// One indexed read per request: a signature alone cannot say that the account
// was deleted since. No row (reaped), or a token issued at or before
// users.tokens_revoked_at (DELETE /users/me), is a 401.
// iat is whole seconds, so a token issued in the same second AFTER the stamp
// is refused too; signing back in takes an SMS code, never under a second.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  const token = header.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT tokens_revoked_at FROM users WHERE id = $1`,
      [payload.sub]
    );
    const revokedAt = rows[0] && rows[0].tokens_revoked_at;
    if (!rows[0] || (revokedAt && payload.iat <= Math.floor(new Date(revokedAt).getTime() / 1000))) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = { id: payload.sub };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth };
