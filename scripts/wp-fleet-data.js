/**
 * Accurate Western Province per-route fleet data, transcribed from
 * "Information of Bus Routes in Western Province - Year 2020".
 *
 *   fleet   = "Daily Operation" column (buses operating on the route per day;
 *             used as the approximate peak concurrent fleet).
 *   permits = total route permits issued (full fleet incl. spares).
 *
 * `estimated: true` marks routes whose figures are NOT in the source PDF
 * (101 has no operation row; 255 is a synthetic demo route).
 */
module.exports = {
  '1/3':     { fleet: 19, permits: 24, service: 'PUBLIC' },
  '100':     { fleet: 86, permits: 97, service: 'PUBLIC' },
  '101':     { fleet: 37, permits: 50, service: 'PUBLIC', estimated: true },
  '102/256': { fleet: 2,  permits: 2,  service: 'PUBLIC' },
  '103':     { fleet: 2,  permits: 2,  service: 'PUBLIC' },
  '104':     { fleet: 64, permits: 85, service: 'PUBLIC' },
  '107':     { fleet: 1,  permits: 2,  service: 'PUBLIC' },
  '117':     { fleet: 18, permits: 28, service: 'PUBLIC' },
  '119':     { fleet: 64, permits: 76, service: 'PUBLIC' },
  '120':     { fleet: 36, permits: 51, service: 'PUBLIC' },
  '122':     { fleet: 55, permits: 63, service: 'PUBLIC' },
  '125':     { fleet: 30, permits: 28, service: 'PUBLIC' },
  '129':     { fleet: 28, permits: 30, service: 'PUBLIC' },
  '135':     { fleet: 29, permits: 29, service: 'PUBLIC' },
  '138':     { fleet: 68, permits: 78, service: 'PUBLIC' },
  '138/4':   { fleet: 43, permits: 53, service: 'PUBLIC' },
  '140':     { fleet: 20, permits: 27, service: 'PUBLIC' },
  '142':     { fleet: 2,  permits: 1,  service: 'PUBLIC' },
  '143':     { fleet: 17, permits: 28, service: 'PUBLIC' },
  '144':     { fleet: 19, permits: 24, service: 'PUBLIC' },
  '147':     { fleet: 1,  permits: 1,  service: 'PUBLIC' },
  '150':     { fleet: 13, permits: 24, service: 'PUBLIC' },
  '180':     { fleet: 34, permits: 50, service: 'PUBLIC' },
  '187':     { fleet: 14, permits: 36, service: 'PUBLIC' },
  '255':     { fleet: 15, permits: 20, service: 'PUBLIC', estimated: true },
};
