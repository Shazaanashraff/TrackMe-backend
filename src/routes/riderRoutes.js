const express = require('express');
const { protect, requireUser } = require('../middleware/auth');
const { listRiders, createRider, updateRider, archiveRider, getRiderAvatar } = require('../controllers/studentController');

const router = express.Router();
router.use(protect, requireUser);
router.get('/', listRiders);
router.post('/', createRider);
router.patch('/:riderId', updateRider);
router.get('/:riderId/avatar', getRiderAvatar);
router.delete('/:riderId', archiveRider);

module.exports = router;
