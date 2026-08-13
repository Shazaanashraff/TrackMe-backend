// Rider profile management — one Identity, several User documents (the
// account holder plus everyone they manage). See docs/modules/PROFILES.md.
// Every endpoint here is protect + requireUser; POST and DELETE additionally
// require requirePrimaryProfile (only the account holder shapes the
// household); everything targeting an existing profile goes through
// requireOwnProfile first (src/middleware/auth.js), which sets
// req.targetProfile.
const User = require('../models/User');
const Identity = require('../models/Identity');
const DriverEnrollment = require('../models/DriverEnrollment');
const { findHouseholdProfiles } = require('../utils/identityRegistry');
const { issueTokensForUser } = require('../utils/tokens');
const { userPayload } = require('../utils/accountPayload');
const { isValidPhone, PHONE_FORMAT_MESSAGE } = require('../utils/phoneNumber');
const { validateAvatarDataUrl } = require('../utils/avatar');

// A managed profile's avatar is capped tighter than the primary's 2 MB
// (authController.js): GET /api/profiles returns every household member's
// `hasAvatar` flag inline, and a 6-profile household inlining full 2 MB
// avatars would be a double-digit-MB response on a mobile connection.
const MANAGED_AVATAR_MAX_BYTES = 512 * 1024;

// Sane ceiling so a compromised or scripted caller can't spin up hundreds of
// profiles under one login — comfortably above any real household or small
// office roster.
const HOUSEHOLD_LIMIT = 20;

const profileSummary = (profile) => ({
  _id: profile._id,
  name: profile.name,
  relation: profile.relation || '',
  profileKind: profile.profileKind,
  isActive: profile.isActive !== false,
  hasAvatar: Boolean(profile.avatarUrl)
});

// @route GET /api/profiles
// Every rider profile on the caller's identity, plus the account-level
// details (email, the primary's phone/name) every profile in the switcher
// needs to show "signed in as <email>" regardless of which one is active.
exports.listProfiles = async (req, res, next) => {
  try {
    if (!req.identityId) {
      return res.status(200).json({ success: true, data: [], account: null });
    }

    const [profiles, identity] = await Promise.all([
      findHouseholdProfiles(req.identityId),
      Identity.findById(req.identityId)
    ]);

    const primary = profiles.find((p) => p.profileKind === 'PRIMARY');

    return res.status(200).json({
      success: true,
      data: profiles.map(profileSummary),
      account: {
        email: identity?.email || '',
        phoneNumber: primary?.phoneNumber || '',
        name: primary?.name || ''
      }
    });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/profiles/:id/avatar
// Kept off the list response on purpose — see MANAGED_AVATAR_MAX_BYTES above.
exports.getProfileAvatar = async (req, res, next) => {
  try {
    return res.status(200).json({
      success: true,
      data: { avatarUrl: req.targetProfile.avatarUrl || '' }
    });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/profiles
// requirePrimaryProfile upstream: only the account holder adds a dependant.
exports.createProfile = async (req, res, next) => {
  try {
    const { name, relation, phoneNumber, avatarUrl } = req.body;

    const householdSize = await User.countDocuments({
      identityId: req.identityId,
      isActive: { $ne: false }
    });
    if (householdSize >= HOUSEHOLD_LIMIT) {
      return res.status(409).json({
        success: false,
        code: 'HOUSEHOLD_LIMIT',
        message: `A single account can hold at most ${HOUSEHOLD_LIMIT} rider profiles`
      });
    }

    const fields = {
      name: String(name).trim(),
      relation: relation ? String(relation).trim() : '',
      identityId: req.identityId,
      profileKind: 'MANAGED',
      isActive: true
    };

    if (phoneNumber !== undefined && String(phoneNumber).trim() !== '') {
      const trimmedPhone = String(phoneNumber).trim();
      if (!isValidPhone(trimmedPhone)) {
        return res.status(400).json({ success: false, message: PHONE_FORMAT_MESSAGE });
      }
      fields.phoneNumber = trimmedPhone;
    }

    if (avatarUrl) {
      const check = validateAvatarDataUrl(avatarUrl, MANAGED_AVATAR_MAX_BYTES);
      if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });
      fields.avatarUrl = avatarUrl;
    }

    const profile = await User.create(fields);

    return res.status(201).json({ success: true, data: profileSummary(profile) });
  } catch (error) {
    next(error);
  }
};

// @route PATCH /api/profiles/:id
// requireOwnProfile upstream: any household member's session may edit any
// profile that shares its identity — the account holder managing the
// household from their own session, or a profile editing itself once
// switched in. Deliberately does not touch phoneNumber: that field is set
// once at creation (above) and from then on only PUT /api/auth/profile
// changes it, and only for the profile that is currently active (never a
// managed one — see authController.updateProfile) — one field, one route,
// no risk of two differently-validated paths drifting.
exports.updateProfileById = async (req, res, next) => {
  try {
    const { name, relation, avatarUrl } = req.body;
    const target = req.targetProfile;

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, message: 'Name is required' });
      }
      target.name = trimmed;
    }

    if (relation !== undefined) {
      target.relation = String(relation).trim();
    }

    if (avatarUrl !== undefined) {
      if (avatarUrl === '' || avatarUrl === null) {
        target.avatarUrl = '';
      } else {
        const maxBytes = target.profileKind === 'MANAGED' ? MANAGED_AVATAR_MAX_BYTES : 2 * 1024 * 1024;
        const check = validateAvatarDataUrl(avatarUrl, maxBytes);
        if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });
        target.avatarUrl = avatarUrl;
      }
    }

    await target.save();

    return res.status(200).json({ success: true, data: profileSummary(target) });
  } catch (error) {
    next(error);
  }
};

// @route DELETE /api/profiles/:id
// requirePrimaryProfile + requireOwnProfile upstream: only the account
// holder removes a household member. Soft delete only — BoardingEvent and
// DriverEnrollment history reference the profile id, and attendance is a
// record, not a UI convenience, so it must survive. qrTokenVersion is bumped
// so any pass already printed/screenshotted for this profile stops working
// immediately, matching the existing rotate-QR behaviour.
exports.removeProfile = async (req, res, next) => {
  try {
    const target = req.targetProfile;

    if (target.profileKind === 'PRIMARY') {
      return res.status(409).json({
        success: false,
        code: 'CANNOT_DELETE_PRIMARY',
        message: 'The account holder profile cannot be removed'
      });
    }

    target.isActive = false;
    target.deletedAt = new Date();
    target.qrTokenVersion += 1;
    await target.save();

    await DriverEnrollment.deleteMany({ userId: target._id });

    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/profiles/:id/switch
// requireOwnProfile upstream. Issues a fresh token pair for the target
// profile through the exact path login uses (utils/tokens.js) — the
// previously-active profile's own refresh token is left alone, so switching
// away and back does not require signing in twice.
exports.switchProfile = async (req, res, next) => {
  try {
    const target = req.targetProfile;

    if (target.isActive === false) {
      return res.status(403).json({ success: false, message: 'This profile has been deactivated' });
    }

    const identity = await Identity.findById(req.identityId);
    const tokens = await issueTokensForUser(target, 'user');

    return res.status(200).json({
      success: true,
      message: 'Switched profile',
      ...tokens,
      user: userPayload(target, 'user', identity)
    });
  } catch (error) {
    next(error);
  }
};
