const HouseholdPlace = require('../models/HouseholdPlace');
const RiderProfile = require('../models/RiderProfile');
const DriverEnrollment = require('../models/DriverEnrollment');

function normalizedPlace(body) {
  const lat = Number(body?.coordinates?.lat);
  const lng = Number(body?.coordinates?.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { error: 'Valid location coordinates are required' };
  }
  const label = String(body?.label || '').trim();
  const address = String(body?.address || '').trim();
  if (!label || !address) return { error: 'Location label and address are required' };
  return { label, address, placeId: String(body?.placeId || ''), coordinates: { lat, lng } };
}

exports.listPlaces = async (req, res, next) => {
  try {
    const data = await HouseholdPlace.find({ accountId: req.user._id, isActive: { $ne: false } }).sort({ label: 1 });
    return res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
};

exports.createPlace = async (req, res, next) => {
  try {
    const parsed = normalizedPlace(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const place = await HouseholdPlace.create({ accountId: req.user._id, ...parsed });
    return res.status(201).json({ success: true, data: place });
  } catch (error) { next(error); }
};

exports.updatePlace = async (req, res, next) => {
  try {
    const parsed = normalizedPlace(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const place = await HouseholdPlace.findOneAndUpdate(
      { _id: req.params.placeId, accountId: req.user._id, isActive: { $ne: false } },
      parsed,
      { new: true, runValidators: true }
    );
    if (!place) return res.status(404).json({ success: false, message: 'Location not found' });
    return res.status(200).json({ success: true, data: place });
  } catch (error) { next(error); }
};

exports.archivePlace = async (req, res, next) => {
  try {
    const place = await HouseholdPlace.findOne({ _id: req.params.placeId, accountId: req.user._id, isActive: { $ne: false } });
    if (!place) return res.status(404).json({ success: false, message: 'Location not found' });
    const [studentUses, enrollmentUses] = await Promise.all([
      RiderProfile.exists({ accountId: req.user._id, isActive: { $ne: false }, $or: [{ defaultPickupPlaceId: place._id }, { defaultDropoffPlaceId: place._id }] }),
      DriverEnrollment.exists({ $or: [{ pickupPlaceId: place._id }, { dropoffPlaceId: place._id }], status: { $in: ['ACTIVE', 'PENDING'] } })
    ]);
    if (studentUses || enrollmentUses) {
      return res.status(409).json({ success: false, message: 'This location is still assigned to a rider or shuttle' });
    }
    place.isActive = false;
    await place.save();
    return res.status(200).json({ success: true, message: 'Location removed' });
  } catch (error) { next(error); }
};
