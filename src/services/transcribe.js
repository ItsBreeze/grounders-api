/**
 * Speech-to-text.
 *
 * Mirrors Offhand's transcriber (offhand/server/src/services/transcribe.js):
 * the same function shape — a Buffer in, `{ text, durationMs }` out — and the
 * same Deepgram request, so the two suites produce comparable transcripts and
 * a fix to one is a fix you can read across to the other. Only Deepgram is
 * carried over; the providers Offhand keeps for meeting recordings (AssemblyAI
 * diarization, Whisper) buy nothing for a thirty-second voice memo. Adding one
 * back is a case in the switch and nothing else.
 *
 * Offhand reaches the network through undici; this repo has no such dependency
 * and its other outbound calls (src/mcp/tools.js) use the global fetch Node 18+
 * ships, which is also what the test harness stubs. So: fetch.
 *
 * "Not configured" and "failed" are different answers. With no DEEPGRAM_API_KEY
 * the caller must be able to leave the row untouched rather than mark it
 * failed, so that case throws with status 501 and code 'not_configured' — the
 * same distinction Offhand draws, for the same reason.
 */

const PROVIDER = process.env.TRANSCRIBE_PROVIDER || 'deepgram';

// A voice memo is short, Deepgram charges by the audio minute, and the whole
// object sits in memory while it is posted — so there is a ceiling. 25 MB is
// about an hour of the AAC/Opus the apps record, which is far longer than any
// memo anyone has sent and still a single comfortable buffer. It is set in
// the same order as radio_send's 20 MB send cap deliberately: both are "one
// object, in memory, once". Past it the job fails closed with a reason
// instead of quietly running up a bill on something that is not a memo.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// And a wall-clock ceiling, so a provider that stops answering cannot pin a
// background job open forever.
const TRANSCRIBE_TIMEOUT_MS = 120000;

function notConfigured(message) {
  return Object.assign(new Error(message), { status: 501, code: 'not_configured' });
}

/** True when the configured provider has what it needs to be called at all. */
function isConfigured() {
  switch (PROVIDER) {
    case 'deepgram': return !!process.env.DEEPGRAM_API_KEY;
    case 'none':     return false;
    default:         return false;
  }
}

/**
 * Transcribe audio bytes. Resolves `{ text, durationMs }`; durationMs is null
 * when the provider does not report one.
 */
async function transcribe(audioBuffer, mimeType = 'audio/m4a') {
  if (!audioBuffer || !audioBuffer.length) {
    throw Object.assign(new Error('nothing to transcribe (empty audio)'), { status: 400 });
  }
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw Object.assign(
      new Error(`audio is ${audioBuffer.length} bytes; the transcription limit is ${MAX_AUDIO_BYTES}`),
      { status: 413 },
    );
  }

  switch (PROVIDER) {
    case 'deepgram': return transcribeDeepgram(audioBuffer, mimeType);
    case 'none':     throw notConfigured('Transcription is disabled (TRANSCRIBE_PROVIDER=none)');
    default:         throw new Error(`Unknown TRANSCRIBE_PROVIDER: ${PROVIDER}`);
  }
}

async function transcribeDeepgram(audioBuffer, mimeType) {
  if (!process.env.DEEPGRAM_API_KEY) throw notConfigured('DEEPGRAM_API_KEY is not set');
  if (typeof fetch !== 'function') throw new Error('no fetch available to reach Deepgram');

  // diarize + punctuate give a reader — and the assistant on the other end of
  // the connector — speaker turns and sentence boundaries to work with.
  const url = 'https://api.deepgram.com/v1/listen'
    + '?model=nova-3&smart_format=true&punctuate=true&diarize=true&paragraphs=true';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      'Content-Type': mimeType || 'application/octet-stream',
    },
    body: audioBuffer,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Deepgram ${res.status}: ${detail.slice(0, 300)}`);
  }

  const json = await res.json();
  const alt = json.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) throw new Error('Deepgram returned no transcript');

  const text = alt.paragraphs?.transcript || alt.transcript || '';
  const durationMs = json.metadata?.duration
    ? Math.round(json.metadata.duration * 1000)
    : null;

  return { text: text.trim(), durationMs };
}

module.exports = {
  transcribe, isConfigured, PROVIDER, MAX_AUDIO_BYTES, TRANSCRIBE_TIMEOUT_MS,
};
