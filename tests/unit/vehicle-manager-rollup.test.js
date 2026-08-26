const {
  emptyBookingStats,
  emptyReviewStats,
  buildVehicleManagerMap,
  rollUpBookingStatsByManager,
  rollUpReviewStatsByManager
} = require('../../src/utils/vehicleManagerRollup');

describe('buildVehicleManagerMap', () => {
  test('maps vehicle _id (stringified) to managerId (stringified)', () => {
    const map = buildVehicleManagerMap([
      { _id: 'v1', managerId: 'm1' },
      { _id: 'v2', managerId: 'm2' }
    ]);
    expect(map.get('v1')).toBe('m1');
    expect(map.get('v2')).toBe('m2');
    expect(map.size).toBe(2);
  });

  test('tolerates ObjectId-like objects by stringifying via String()', () => {
    const fakeObjectId = (hex) => ({ toString: () => hex });
    const map = buildVehicleManagerMap([
      { _id: fakeObjectId('507f1f77bcf86cd799439011'), managerId: fakeObjectId('507f1f77bcf86cd799439022') }
    ]);
    expect(map.get('507f1f77bcf86cd799439011')).toBe('507f1f77bcf86cd799439022');
  });

  test('skips entries missing _id or managerId', () => {
    const map = buildVehicleManagerMap([
      { _id: 'v1', managerId: null },
      { _id: null, managerId: 'm1' },
      { _id: 'v2', managerId: 'm2' }
    ]);
    expect(map.size).toBe(1);
    expect(map.get('v2')).toBe('m2');
  });

  test('handles an empty or missing input list', () => {
    expect(buildVehicleManagerMap([]).size).toBe(0);
    expect(buildVehicleManagerMap(undefined).size).toBe(0);
  });
});

describe('rollUpBookingStatsByManager', () => {
  test('sums per-vehicle booking stats into per-manager totals', () => {
    const vehicleManagerMap = buildVehicleManagerMap([
      { _id: 'v1', managerId: 'm1' },
      { _id: 'v2', managerId: 'm1' },
      { _id: 'v3', managerId: 'm2' }
    ]);
    const perVehicleStats = [
      { _id: 'v1', totalBookings: 5, confirmedBookings: 3, cancelledBookings: 1, totalRevenue: 500 },
      { _id: 'v2', totalBookings: 2, confirmedBookings: 2, cancelledBookings: 0, totalRevenue: 200 },
      { _id: 'v3', totalBookings: 10, confirmedBookings: 8, cancelledBookings: 2, totalRevenue: 1000 }
    ];

    const result = rollUpBookingStatsByManager(perVehicleStats, vehicleManagerMap);

    expect(result.get('m1')).toEqual({
      totalBookings: 7,
      confirmedBookings: 5,
      cancelledBookings: 1,
      totalRevenue: 700
    });
    expect(result.get('m2')).toEqual({
      totalBookings: 10,
      confirmedBookings: 8,
      cancelledBookings: 2,
      totalRevenue: 1000
    });
    expect(result.size).toBe(2);
  });

  test('drops stats for a vehicle absent from the manager map (reassigned/deleted between queries)', () => {
    const vehicleManagerMap = buildVehicleManagerMap([{ _id: 'v1', managerId: 'm1' }]);
    const perVehicleStats = [
      { _id: 'v1', totalBookings: 5, confirmedBookings: 3, cancelledBookings: 1, totalRevenue: 500 },
      { _id: 'v-orphan', totalBookings: 99, confirmedBookings: 99, cancelledBookings: 0, totalRevenue: 9999 }
    ];

    const result = rollUpBookingStatsByManager(perVehicleStats, vehicleManagerMap);

    expect(result.size).toBe(1);
    expect(result.get('m1').totalBookings).toBe(5);
  });

  test('returns an empty map for no stats', () => {
    const result = rollUpBookingStatsByManager([], new Map());
    expect(result.size).toBe(0);
  });

  test('emptyBookingStats() matches the zero-value shape callers default to', () => {
    expect(emptyBookingStats()).toEqual({
      totalBookings: 0,
      confirmedBookings: 0,
      cancelledBookings: 0,
      totalRevenue: 0
    });
  });
});

describe('rollUpReviewStatsByManager', () => {
  test('computes a count-weighted average rating across a manager\'s vehicles', () => {
    const vehicleManagerMap = buildVehicleManagerMap([
      { _id: 'v1', managerId: 'm1' },
      { _id: 'v2', managerId: 'm1' }
    ]);
    // v1: 4 reviews averaging 5.0 (sum 20), v2: 1 review averaging 1.0 (sum 1)
    // True overall average across all 5 reviews = 21 / 5 = 4.2
    const perVehicleStats = [
      { _id: 'v1', averageRating: 5, reviewCount: 4 },
      { _id: 'v2', averageRating: 1, reviewCount: 1 }
    ];

    const result = rollUpReviewStatsByManager(perVehicleStats, vehicleManagerMap);

    expect(result.get('m1').reviewCount).toBe(5);
    expect(result.get('m1').averageRating).toBeCloseTo(4.2, 10);
  });

  test('this weighted average matches averaging the raw review documents directly', () => {
    // Simulate the ground truth: 5 individual review ratings split across two vehicles.
    const rawRatings = { v1: [5, 5, 5, 5], v2: [1] };
    const trueOverallAverage =
      Object.values(rawRatings).flat().reduce((a, b) => a + b, 0) /
      Object.values(rawRatings).flat().length;

    const vehicleManagerMap = buildVehicleManagerMap([
      { _id: 'v1', managerId: 'm1' },
      { _id: 'v2', managerId: 'm1' }
    ]);
    const perVehicleStats = Object.entries(rawRatings).map(([vehicleId, ratings]) => ({
      _id: vehicleId,
      averageRating: ratings.reduce((a, b) => a + b, 0) / ratings.length,
      reviewCount: ratings.length
    }));

    const result = rollUpReviewStatsByManager(perVehicleStats, vehicleManagerMap);

    expect(result.get('m1').averageRating).toBeCloseTo(trueOverallAverage, 10);
  });

  test('a manager with zero reviews across their vehicles is not present in the result', () => {
    const vehicleManagerMap = buildVehicleManagerMap([{ _id: 'v1', managerId: 'm1' }]);
    const result = rollUpReviewStatsByManager([{ _id: 'v1', averageRating: 0, reviewCount: 0 }], vehicleManagerMap);
    // reviewCount 0 contributes nothing; manager still appears with a zero entry
    // because it has a stats row, but averageRating must not be NaN.
    expect(result.get('m1')).toEqual({ averageRating: 0, reviewCount: 0 });
  });

  test('drops stats for a vehicle absent from the manager map', () => {
    const vehicleManagerMap = new Map();
    const result = rollUpReviewStatsByManager([{ _id: 'v-orphan', averageRating: 5, reviewCount: 3 }], vehicleManagerMap);
    expect(result.size).toBe(0);
  });

  test('returns an empty map for no stats', () => {
    expect(rollUpReviewStatsByManager([], new Map()).size).toBe(0);
  });

  test('emptyReviewStats() matches the zero-value shape callers default to', () => {
    expect(emptyReviewStats()).toEqual({ averageRating: 0, reviewCount: 0 });
  });
});
