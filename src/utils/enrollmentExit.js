const Vehicle = require('../models/Vehicle');

// What has to happen after a rider's enrollment row is deleted, whoever deleted
// it: the rider leaving (enrollmentController.leaveEnrollment) or their account
// being scheduled for deletion (services/accountDeletion.js).
//
// Their upcoming absence notices are retired, and if they were ACTIVE, a
// live-tracking socket they had open on the vehicle is told to leave the room
// now rather than when it next disconnects.
const afterEnrollmentRemoved = async (enrollment, io) => {
  // Lazy: services/communications requires models that require this file's
  // callers, and only this path needs it.
  await require('../services/communications').retireAbsences({ enrollmentId: enrollment._id });

  if (enrollment.status !== 'ACTIVE') return;
  const vehicle = await Vehicle.findOne({ driverId: enrollment.driverId, isDeleted: false })
    .select('vehicleId')
    .lean();
  if (vehicle) {
    io?.to(`vehicle:${vehicle.vehicleId}`).emit('vehicle:access-revoked', {
      vehicleId: vehicle.vehicleId,
      riderId: String(enrollment.studentId || '')
    });
  }
};

module.exports = { afterEnrollmentRemoved };
