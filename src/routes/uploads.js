/**
 * Upload routes
 *
 * GET /upload-url?type=photo|video|audio
 *   Returns a pre-signed PUT URL for direct upload to Cloudflare R2.
 *   Flutter uploads the file directly to R2, then passes the resulting
 *   media_url to POST /posts. The API never touches the binary data.
 *
 * Required env vars:
 *   R2_ACCOUNT_ID        — Cloudflare account ID
 *   R2_ACCESS_KEY_ID     — R2 API token (Access Key ID)
 *   R2_SECRET_ACCESS_KEY — R2 API token (Secret Access Key)
 *   R2_BUCKET_NAME       — e.g. "grounders-media"
 *   R2_PUBLIC_URL        — e.g. "https://media.grounders.app" (your R2 public domain)
 */

const router  = require('express').Router();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const ALLOWED_TYPES = ['photo', 'video', 'audio'];

const MIME = {
  photo: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/mp4',
};

const EXT = {
  photo: 'jpg',
  video: 'mp4',
  audio: 'm4a',
};

function r2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// GET /upload-url?type=photo|video|audio
router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query;

    if (!ALLOWED_TYPES.includes(type)) {
      return res.status(400).json({ error: 'type must be photo, video, or audio' });
    }

    const userId   = req.user.id;
    const fileId   = uuid();
    const thumbId  = uuid();
    const key      = `posts/${userId}/${fileId}.${EXT[type]}`;
    const thumbKey = type !== 'audio' ? `posts/${userId}/${thumbId}_thumb.jpg` : null;

    const client = r2Client();
    const bucket = process.env.R2_BUCKET_NAME;
    const base   = process.env.R2_PUBLIC_URL;

    // Pre-signed URL for the main media file (valid 10 minutes)
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket:      bucket,
        Key:         key,
        ContentType: MIME[type],
      }),
      { expiresIn: 600 }
    );

    // Pre-signed URL for the thumbnail (photo + video only)
    let thumbUploadUrl = null;
    if (thumbKey) {
      thumbUploadUrl = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket:      bucket,
          Key:         thumbKey,
          ContentType: 'image/jpeg',
        }),
        { expiresIn: 600 }
      );
    }

    res.json({
      upload_url:       uploadUrl,
      thumb_upload_url: thumbUploadUrl,
      media_url:        `${base}/${key}`,
      media_thumb_url:  thumbKey ? `${base}/${thumbKey}` : null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
