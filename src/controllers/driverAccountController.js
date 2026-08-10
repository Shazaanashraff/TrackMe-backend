const Driver = require('../models/Driver');
const { ensureDriverEnrollmentKey } = require('../utils/enrollmentKey');

// @desc    The signed-in driver's own enrollment key
// @route   GET /api/driver/enrollment-key
// @access  Private (driver)
// The key was readable only by the owning manager, so a driver had to be told
// their own key out of band before they could pass it to a passenger. This
// hands a driver the key for their own account and nobody else's: the id comes
// from the token, never from the request, so there is no driver to enumerate.
exports.getMyEnrollmentKey = async (req, res, next) => {
  try {
    // Read privacy back rather than trusting the token's copy: whether redeeming
    // needs approval is the manager's to change, and the card tells the driver
    // what will happen when someone uses this key.
    const driver = await Driver.findById(req.user._id).select('isPrivate');
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    // Drivers created before keys existed have none until something asks, so
    // this issues on first read rather than returning an empty card.
    const enrollmentKey = await ensureDriverEnrollmentKey(driver._id);

    return res.status(200).json({
      success: true,
      data: { enrollmentKey, isPrivate: driver.isPrivate === true }
    });
  } catch (error) {
    next(error);
  }
};
