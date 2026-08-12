// Shared primitives for validating a base64 avatar data URL. Extracted so
// profileController's managed-profile avatars (capped tighter, at 512 KB —
// see docs/modules/PROFILES.md) can reuse the same format check as
// authController's own 2 MB primary-profile avatar, instead of a second
// hand-rolled copy of the regex and byte-length math.
const AVATAR_DATA_URL_REGEX = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

// Decoded byte length of a base64 string without allocating a Buffer copy.
const base64ByteLength = (b64) => {
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (len * 3) / 4 - padding;
};

// Validates a submitted avatar string against the data-URL shape and a byte
// cap. Returns `{ ok: true }` or `{ ok: false, status, message }` so the
// caller can turn a failure straight into a response.
const validateAvatarDataUrl = (avatar, maxBytes) => {
  if (typeof avatar !== 'string') {
    return { ok: false, status: 400, message: 'Invalid image format' };
  }

  const match = AVATAR_DATA_URL_REGEX.exec(avatar);
  if (!match) {
    return { ok: false, status: 400, message: 'Profile picture must be a PNG, JPEG, or WebP image' };
  }

  if (base64ByteLength(match[2]) > maxBytes) {
    return {
      ok: false,
      status: 413,
      message: `Profile picture is too large (max ${Math.round(maxBytes / 1024)} KB)`
    };
  }

  return { ok: true };
};

module.exports = { AVATAR_DATA_URL_REGEX, base64ByteLength, validateAvatarDataUrl };
