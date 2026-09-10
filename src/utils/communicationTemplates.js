const { ApiError } = require('../middleware/errorHandler');
const today = (now = new Date()) => new Date(+now + 330 * 60000).toISOString().slice(0, 10);
function validateDate(value, editable = true) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, 'Use a valid YYYY-MM-DD date');
  }
  const last = new Date(Date.parse(today()) + 30 * 86400000).toISOString().slice(0, 10);
  if (editable && (value < today() || value > last)) throw new ApiError(400, 'Choose today through 30 days ahead in Asia/Colombo');
  return value;
}
// The one-tap grid on the driver's broadcast panel. Deliberately two entries: a
// driver mid-route taps, they don't browse. Anything else (a custom delay, an
// unavailable date, free text) is a few taps further on under More updates.
//
// Delay wording names no cause. A driver rarely knows why they are behind, and
// a message that blames traffic is wrong as often as it is right.
const PRESETS = [
  { id: 'on_my_way', label: 'On my way', text: 'I’m on my way. Please be ready at your pickup point.' },
  { id: 'delay_10', label: 'Delay · 10 min', text: 'I’m running about 10 minutes behind. Sorry for the inconvenience, I’ll update you if this changes.' },
];
function minutes(value) {
  if (!Number.isInteger(value) || value < 1 || value > 180) throw new ApiError(400, 'Minutes must be an integer from 1 to 180');
  return value;
}
function canonical(body, role, riderName, broadcast = false) {
  const { templateId, parameters = {} } = body;
  if (!templateId || templateId === 'custom') {
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.trim().length > 1000) throw new ApiError(400, 'Message must contain 1–1,000 characters');
    return body.text.trim();
  }
  if (role === 'driver') {
    const preset = PRESETS.find(p => p.id === templateId);
    if (preset) return preset.text;
    // Wire id stays 'traffic' even though the wording no longer says traffic:
    // it is stored on Message.templateId and on queued Announcements, so
    // renaming it would strand anything already in flight for no user gain.
    if (templateId === 'traffic') return `I’m running about ${minutes(parameters.minutes)} minutes behind. Sorry for the inconvenience, I’ll update you if this changes.`;
    if (templateId === 'unavailable') return `Service will be unavailable on ${validateDate(parameters.date)}. Please arrange alternative transport.`;
    if (!broadcast) {
      const individual = { arrived: 'I’ve arrived at your pickup point.', passed: 'I’ve already passed your stop.', can_collect: 'I can collect you. Please wait at your pickup point.' };
      if (individual[templateId]) return individual[templateId];
    }
  } else {
    const name = riderName || 'The rider';
    const replies = { ready: `${name} is ready at the pickup point.`, waiting: `${name} is waiting at the pickup point.`, thanks: `Thank you from ${name}.` };
    if (replies[templateId]) return replies[templateId];
    if (templateId === 'running_late') return `${name} is running ${minutes(parameters.minutes)} minutes late.`;
  }
  throw new ApiError(400, 'Unsupported message template');
}
module.exports = { today, validateDate, canonical, PRESETS };
