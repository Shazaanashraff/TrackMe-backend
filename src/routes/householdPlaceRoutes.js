const express = require('express');
const { protect, requireUser } = require('../middleware/auth');
const { listPlaces, createPlace, updatePlace, archivePlace } = require('../controllers/householdPlaceController');

const router = express.Router();
router.use(protect, requireUser);
router.get('/', listPlaces);
router.post('/', createPlace);
router.patch('/:placeId', updatePlace);
router.delete('/:placeId', archivePlace);

module.exports = router;
