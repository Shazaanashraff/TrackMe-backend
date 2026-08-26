require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const StudentProfile = require('../src/models/StudentProfile');
const Driver = require('../src/models/Driver');
const DriverEnrollment = require('../src/models/DriverEnrollment');
const StudentOrganizationProfile = require('../src/models/StudentOrganizationProfile');
const Notification = require('../src/models/Notification');
const { generateUniqueRiderCode } = require('../src/utils/riderCode');

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');

async function migrate() {
  const users = await User.find({}).select('name avatarUrl qrTokenVersion qrIssuedAt');
  const existingCount = await StudentProfile.countDocuments();
  const legacyEnrollments = await DriverEnrollment.countDocuments({ studentId: { $exists: false } });
  console.log(`Parent accounts: ${users.length}`);
  console.log(`Existing student profiles: ${existingCount}`);
  console.log(`Legacy enrollments: ${legacyEnrollments}`);
  if (!APPLY) {
    console.log('Dry run complete. Re-run with --apply to write changes.');
    return;
  }

  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await StudentProfile.exists({ accountId: user._id });
    if (!exists) {
      // eslint-disable-next-line no-await-in-loop
      await StudentProfile.create({
        _id: user._id,
        accountId: user._id,
        // eslint-disable-next-line no-await-in-loop
        riderCode: await generateUniqueRiderCode(StudentProfile),
        fullName: user.name,
        avatarUrl: user.avatarUrl || '',
        qrTokenVersion: user.qrTokenVersion || 1,
        qrIssuedAt: user.qrIssuedAt || null,
        migratedFromLegacyUser: true
      });
    }
  }

  const enrollments = await DriverEnrollment.find({ studentId: { $exists: false } });
  for (const enrollment of enrollments) {
    const student = await StudentProfile.findOne({ accountId: enrollment.userId }).sort({ createdAt: 1 });
    if (!student) continue;
    enrollment.studentId = student._id;
    const driver = await Driver.findById(enrollment.driverId).select('organization');
    if (driver?.organization) {
      const profile = await StudentOrganizationProfile.findOneAndUpdate(
        { studentId: student._id, organizationId: driver.organization },
        { $setOnInsert: { schemaVersion: 1, values: {}, legacyGrandfathered: true, needsUpdate: false } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      enrollment.organizationProfileId = profile._id;
    }
    enrollment.userId = null;
    // eslint-disable-next-line no-await-in-loop
    await enrollment.save();
  }

  await Notification.updateMany(
    { studentId: null, userId: { $in: users.map((user) => user._id) } },
    [{ $set: { studentId: '$userId', 'data.studentId': { $toString: '$userId' } } }]
  );
  console.log('Student-profile migration applied. Run with --verify next.');
}

async function verify() {
  const missingStudents = await User.aggregate([
    { $lookup: { from: StudentProfile.collection.name, localField: '_id', foreignField: 'accountId', as: 'students' } },
    { $match: { students: { $size: 0 } } },
    { $count: 'count' }
  ]);
  const legacyEnrollments = await DriverEnrollment.countDocuments({
    $or: [{ studentId: { $exists: false } }, { studentId: null }]
  });
  const danglingEnrollments = await DriverEnrollment.aggregate([
    { $lookup: { from: StudentProfile.collection.name, localField: 'studentId', foreignField: '_id', as: 'student' } },
    { $match: { student: { $size: 0 } } },
    { $count: 'count' }
  ]);
  const failures = {
    accountsWithoutStudents: missingStudents[0]?.count || 0,
    legacyEnrollments,
    danglingEnrollments: danglingEnrollments[0]?.count || 0
  };
  console.log(failures);
  if (Object.values(failures).some((count) => count > 0)) throw new Error('Student-profile migration verification failed');
  console.log('Student-profile migration verification passed.');
}

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    if (VERIFY) await verify();
    else await migrate();
  } finally {
    await mongoose.connection.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { migrate, verify };
