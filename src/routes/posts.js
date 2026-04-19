const router = require('express').Router({ mergeParams: true });
const { v4: uuid } = require('uuid');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { haversineMetres } = require('../utils/geo');
const { canonicalPair } = require('../utils/friends');

router.use(requireAuth);

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      type, media_url, media_thumb_url, description, audio_title,
      lat, lng, visibility = 'friends', captured_at,
      attestation_token, attestation_data,
    } = req.body;

    if (!['photo', 'video', 'audio'].includes(type))
      return res.status(400).json({ error: 'type must be photo, video, or audio' });
    if (!media_url) return res.status(400).json({ error: 'media_url is required' });
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng are required' });
    if (!captured_at) return res.status(400).json({ error: 'captured_at is required' });
    if (type === 'audio' && !audio_title?.trim())
      return res.status(400).json({ error: 'audio_title is required for audio posts' });
    if (!['friends', 'public'].includes(visibility))
      return res.status(400).json({ error: 'visibility must be friends or public' });

    const userId = req.user.id;
    await client.query('BEGIN');

    const postId = uuid();
    const { rows: [post] } = await client.query(
      `INSERT INTO posts
         (id, user_id, type, media_url, media_thumb_url, description,
          audio_title, lat, lng, visibility, captured_at, attestation_token, attestation_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [postId, userId, type, media_url, media_thumb_url || null,
       description || null, audio_title?.trim() || null,
       parseFloat(lat), parseFloat(lng), visibility, new Date(captured_at),
       attestation_token || null, attestation_data ? JSON.stringify(attestation_data) : null]
    );

    const { rows: [user] } = aw
