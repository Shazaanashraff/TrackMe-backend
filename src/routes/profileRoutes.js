const express = require('express');
const router = express.Router();
const {
  listProfiles,
  getProfileAvatar,
  createProfile,
  updateProfileById,
  removeProfile,
  switchProfile
} = require('../controllers/profileController');
const { getHouseholdEnrollments } = require('../controllers/enrollmentController');
const {
  validateProfileId,
  validateCreateProfile,
  validateUpdateProfile
} = require('../middleware/validators');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { protect, requireUser, requireOwnProfile, requirePrimaryProfile } = require('../middleware/auth');

// Rider profiles — see docs/modules/PROFILES.md. Passenger-facing, same as
// enrollmentRoutes.js; managers never call this surface directly.
router.use(protect, requireUser);

router.get('/', listProfiles);
router.get('/household/enrollments', getHouseholdEnrollments);

router.post('/', requirePrimaryProfile, validateCreateProfile, handleValidationErrors, createProfile);

router.get('/:id/avatar', validateProfileId, handleValidationErrors, requireOwnProfile(), getProfileAvatar);
router.patch('/:id', validateUpdateProfile, handleValidationErrors, requireOwnProfile(), updateProfileById);
router.delete(
  '/:id',
  validateProfileId,
  handleValidationErrors,
  requirePrimaryProfile,
  requireOwnProfile(),
  removeProfile
);
router.post(
  '/:id/switch',
  validateProfileId,
  handleValidationErrors,
  requireOwnProfile(),
  switchProfile
);

module.exports = router;
