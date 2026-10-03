const AppRelease = require('../models/AppRelease');
const { APPS, PLATFORMS } = require('../models/AppRelease');
const { notifyAppUpdateAvailable } = require('../utils/notificationHelper');

// GET /api/app-releases — public. One row per (app, platform): the newest
// isActive:true document for each, so the client apps have a single place to
// fetch "what's current" for every target without 4 round trips.
exports.listLatest = async (req, res, next) => {
  try {
    const releases = await AppRelease.aggregate([
      { $match: { isActive: true } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { app: '$app', platform: '$platform' },
          doc: { $first: '$$ROOT' }
        }
      },
      { $replaceRoot: { newRoot: '$doc' } }
    ]);

    return res.status(200).json({ success: true, releases });
  } catch (error) {
    next(error);
  }
};

// GET /api/app-releases/latest?app=&platform= — public.
exports.getLatestForTarget = async (req, res, next) => {
  try {
    const { app, platform } = req.query;

    if (!app || !APPS.includes(app)) {
      return res.status(400).json({ success: false, message: `app must be one of: ${APPS.join(', ')}` });
    }
    if (!platform || !PLATFORMS.includes(platform)) {
      return res.status(400).json({ success: false, message: `platform must be one of: ${PLATFORMS.join(', ')}` });
    }

    const release = await AppRelease.findOne({ app, platform, isActive: true }).sort({ createdAt: -1 });

    return res.status(200).json({ success: true, release: release || null });
  } catch (error) {
    next(error);
  }
};

// GET /api/app-releases/history?app= — super-admin only. Every row (active or
// not) for the requested app, newest first — the publish/rollback audit trail.
exports.listHistory = async (req, res, next) => {
  try {
    const { app } = req.query;

    if (!app || !APPS.includes(app)) {
      return res.status(400).json({ success: false, message: `app must be one of: ${APPS.join(', ')}` });
    }

    const releases = await AppRelease.find({ app }).sort({ createdAt: -1 });

    return res.status(200).json({ success: true, releases });
  } catch (error) {
    next(error);
  }
};

// POST /api/app-releases — super-admin only. Publishes a new release and
// retires whatever was previously active for the same (app, platform).
exports.createRelease = async (req, res, next) => {
  try {
    const {
      app, platform, version, versionCode, downloadUrl,
      releaseNotes, mandatory, fileSizeBytes
    } = req.body;

    if (!app || !APPS.includes(app)) {
      return res.status(400).json({ success: false, message: `app must be one of: ${APPS.join(', ')}` });
    }
    if (!platform || !PLATFORMS.includes(platform)) {
      return res.status(400).json({ success: false, message: `platform must be one of: ${PLATFORMS.join(', ')}` });
    }
    if (!version || typeof version !== 'string') {
      return res.status(400).json({ success: false, message: 'version is required' });
    }
    if (versionCode === undefined || versionCode === null || Number.isNaN(Number(versionCode))) {
      return res.status(400).json({ success: false, message: 'versionCode is required and must be a number' });
    }
    if (!downloadUrl || typeof downloadUrl !== 'string') {
      return res.status(400).json({ success: false, message: 'downloadUrl is required' });
    }

    // Retire whatever was active for this (app, platform) before publishing the new one.
    await AppRelease.updateMany(
      { app, platform, isActive: true },
      { $set: { isActive: false } }
    );

    const release = await AppRelease.create({
      app,
      platform,
      version,
      versionCode: Number(versionCode),
      downloadUrl,
      releaseNotes: releaseNotes || '',
      mandatory: Boolean(mandatory),
      fileSizeBytes: fileSizeBytes !== undefined ? Number(fileSizeBytes) : undefined,
      isActive: true
    });

    // iOS has no in-app update check, so a push/notification is the only way
    // to tell those users a new build exists. Must never fail the publish.
    if (platform === 'ios') {
      try {
        await notifyAppUpdateAvailable({ app, version, downloadUrl });
      } catch (notifyError) {
        console.error('Error sending app update notification:', notifyError.message);
      }
    }

    return res.status(201).json({ success: true, data: release });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/app-releases/:id — super-admin only. Toggles isActive (e.g. to
// pull a bad release without publishing a replacement).
exports.updateReleaseStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const release = await AppRelease.findById(id);
    if (!release) {
      return res.status(404).json({ success: false, message: 'Release not found' });
    }

    release.isActive = Boolean(isActive);
    await release.save();

    return res.status(200).json({ success: true, data: release });
  } catch (error) {
    next(error);
  }
};
