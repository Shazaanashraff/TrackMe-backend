const { planStatus } = require('../../scripts/migrate-custom-route-status');

// v1 custom routes used PENDING_NAMING ("recorded, waiting for a name"). v2 splits that into
// RECORDING (still collecting rides) and PENDING_REVIEW (a line exists, manager to confirm).
describe('planStatus (custom-route status migration)', () => {
  it('a legacy route that already has a recorded line goes to review', () => {
    expect(planStatus({ status: 'PENDING_NAMING', pathPolyline: '_p~iF~ps|U' })).toBe('PENDING_REVIEW');
  });

  it('a legacy route that never got a line goes back to recording', () => {
    expect(planStatus({ status: 'PENDING_NAMING', pathPolyline: '' })).toBe('RECORDING');
    expect(planStatus({ status: 'PENDING_NAMING' })).toBe('RECORDING');
  });

  it('leaves every other status alone', () => {
    expect(planStatus({ status: 'ACTIVE', pathPolyline: 'x' })).toBeNull();
    expect(planStatus({ status: 'RECORDING' })).toBeNull();
    expect(planStatus({ status: 'PENDING_REVIEW' })).toBeNull();
    expect(planStatus({})).toBeNull();
  });
});
