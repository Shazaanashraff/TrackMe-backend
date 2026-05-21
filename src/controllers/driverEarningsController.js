const DriverEarnings = require('../models/DriverEarnings');
const Bus = require('../models/Bus');
const Route = require('../models/Route');
const Booking = require('../models/Booking');

/**
 * GET /api/driver-earnings/stats
 * Get driver earnings statistics (today, week, month)
 */
const getEarningsStats = async (req, res) => {
  try {
    const driverId = req.user.id;
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getFullYear(), now.getMonth(), 1);

    // Today's earnings
    const todayEarnings = await DriverEarnings.aggregate([
      {
        $match: {
          driverId: new require('mongoose').Types.ObjectId(driverId),
          journeyDate: { $gte: today },
          status: 'ACTIVE'
        }
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: '$netEarnings' },
          totalTrips: { $sum: 1 },
          totalPassengers: { $sum: '$totalPassengers' }
        }
      }
    ]);

    // Week's earnings
    const weekEarnings = await DriverEarnings.aggregate([
      {
        $match: {
          driverId: new require('mongoose').Types.ObjectId(driverId),
          journeyDate: { $gte: weekAgo },
          status: 'ACTIVE'
        }
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: '$netEarnings' },
          totalTrips: { $sum: 1 }
        }
      }
    ]);

    // Month's earnings
    const monthEarnings = await DriverEarnings.aggregate([
      {
        $match: {
          driverId: new require('mongoose').Types.ObjectId(driverId),
          journeyDate: { $gte: monthAgo },
          status: 'ACTIVE'
        }
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: '$netEarnings' },
          totalTrips: { $sum: 1 }
        }
      }
    ]);

    // Pending payouts
    const pendingEarnings = await DriverEarnings.aggregate([
      {
        $match: {
          driverId: new require('mongoose').Types.ObjectId(driverId),
          paymentStatus: 'PENDING'
        }
      },
      {
        $group: {
          _id: null,
          totalPending: { $sum: '$netEarnings' },
          count: { $sum: 1 }
        }
      }
    ]);

    return res.json({
      today: todayEarnings[0] || { totalEarnings: 0, totalTrips: 0, totalPassengers: 0 },
      week: weekEarnings[0] || { totalEarnings: 0, totalTrips: 0 },
      month: monthEarnings[0] || { totalEarnings: 0, totalTrips: 0 },
      pending: pendingEarnings[0] || { totalPending: 0, count: 0 }
    });
  } catch (error) {
    console.error('Get earnings stats error:', error);
    res.status(500).json({ message: 'Failed to fetch earnings stats', error: error.message });
  }
};

/**
 * GET /api/driver-earnings/history
 * Get driver's earnings history with pagination and filters
 */
const getEarningsHistory = async (req, res) => {
  try {
    const driverId = req.user.id;
    const { page = 1, limit = 10, status = null, startDate = null, endDate = null } = req.query;

    const query = { driverId };
    
    if (status && status !== 'ALL') {
      query.paymentStatus = status;
    }

    if (startDate || endDate) {
      query.journeyDate = {};
      if (startDate) query.journeyDate.$gte = new Date(startDate);
      if (endDate) query.journeyDate.$lte = new Date(endDate);
    }

    const earnings = await DriverEarnings.find(query)
      .populate('busId', 'busName registrationNumber')
      .populate('routeId', 'source destination')
      .sort({ journeyDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await DriverEarnings.countDocuments(query);

    return res.json({
      earnings,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalEarnings: total
      }
    });
  } catch (error) {
    console.error('Get earnings history error:', error);
    res.status(500).json({ message: 'Failed to fetch earnings history', error: error.message });
  }
};

/**
 * GET /api/driver-earnings/:earningId
 * Get specific earning details
 */
const getEarningDetails = async (req, res) => {
  try {
    const { earningId } = req.params;
    const driverId = req.user.id;

    const earning = await DriverEarnings.findOne({ _id: earningId, driverId })
      .populate('busId')
      .populate('routeId')
      .lean();

    if (!earning) {
      return res.status(404).json({ message: 'Earning record not found' });
    }

    return res.json(earning);
  } catch (error) {
    console.error('Get earning details error:', error);
    res.status(500).json({ message: 'Failed to fetch earning details', error: error.message });
  }
};

/**
 * POST /api/driver-earnings/log-trip
 * Log a new trip and calculate earnings (typically called by admin/system)
 */
const logTrip = async (req, res) => {
  try {
    const {
      driverId,
      busId,
      routeId,
      journeyDate,
      startTime,
      endTime,
      totalPassengers,
      totalDistance,
      grossEarnings,
      commissionRate = 0.1
    } = req.body;

    // Calculate earnings
    const commission = grossEarnings * commissionRate;
    const netEarnings = grossEarnings - commission;

    const tripId = `TRIP-${new Date().getTime()}-${busId.slice(-4)}`;

    const earning = new DriverEarnings({
      driverId,
      busId,
      tripId,
      routeId,
      journeyDate: new Date(journeyDate),
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      totalDistance,
      totalPassengers,
      grossEarnings,
      commission,
      netEarnings,
      status: 'ACTIVE'
    });

    await earning.save();
    await earning.populate(['busId', 'routeId']);

    return res.status(201).json({
      message: 'Trip logged successfully',
      earning
    });
  } catch (error) {
    console.error('Log trip error:', error);
    res.status(500).json({ message: 'Failed to log trip', error: error.message });
  }
};

/**
 * GET /api/driver-earnings/daily-breakdown
 * Get daily breakdown for current month
 */
const getDailyBreakdown = async (req, res) => {
  try {
    const driverId = req.user.id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const breakdown = await DriverEarnings.aggregate([
      {
        $match: {
          driverId: new require('mongoose').Types.ObjectId(driverId),
          journeyDate: { $gte: monthStart },
          status: 'ACTIVE'
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$journeyDate' }
          },
          earnings: { $sum: '$netEarnings' },
          trips: { $sum: 1 },
          passengers: { $sum: '$totalPassengers' }
        }
      },
      { $sort: { '_id': 1 } }
    ]);

    return res.json({
      month: now.toLocaleString('default', { month: 'long', year: 'numeric' }),
      breakdown
    });
  } catch (error) {
    console.error('Get daily breakdown error:', error);
    res.status(500).json({ message: 'Failed to fetch daily breakdown', error: error.message });
  }
};

/**
 * PATCH /api/driver-earnings/:earningId/request-payout
 * Request payout for pending earnings
 */
const requestPayout = async (req, res) => {
  try {
    const { earningId } = req.params;
    const driverId = req.user.id;
    const { bankAccount } = req.body;

    const earning = await DriverEarnings.findOne({ _id: earningId, driverId });
    
    if (!earning) {
      return res.status(404).json({ message: 'Earning record not found' });
    }

    if (earning.paymentStatus !== 'PENDING') {
      return res.status(400).json({ 
        message: 'Only pending earnings can be requested for payout' 
      });
    }

    // Update earnings record
    earning.paymentStatus = 'PROCESSED';
    earning.bankAccount = bankAccount;
    earning.paymentDate = new Date();

    await earning.save();

    return res.json({
      message: 'Payout request submitted',
      earning,
      estimatedPaymentDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) // 3 days
    });
  } catch (error) {
    console.error('Request payout error:', error);
    res.status(500).json({ message: 'Failed to request payout', error: error.message });
  }
};

module.exports = {
  getEarningsStats,
  getEarningsHistory,
  getEarningDetails,
  logTrip,
  getDailyBreakdown,
  requestPayout
};
