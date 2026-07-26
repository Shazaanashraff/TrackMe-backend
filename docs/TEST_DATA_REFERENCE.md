# Sri Lankan Bus System - Test Data Reference

> **`npm run seed:buses` no longer exists.** The script behind it (`scripts/seed-test-buses.js`)
> created `Driver` documents directly with no `identityId`, which the identity model (see
> [`docs/modules/AUTH.md`](modules/AUTH.md)) requires to log in — so it was removed rather than
> left to silently produce broken accounts. The credentials table below is what it used to
> produce; no replacement has been written yet, so none of these accounts currently exist.

## Quick Start Commands

```bash
# Seed routes (16 authentic SL routes with stops & fares)
npm run seed:routes
```

---

## Test Credentials (historical — see notice above)

### Admin Test Drivers
Each route had a dedicated driver account:

| Route ID | Driver Email | Password | Buses |
|----------|--------------|----------|-------|
| 100 | driver.slt100@bus.com | TestDriver@123 | SL100-A, SL100-B, SL100-C |
| 101 | driver.slt101@bus.com | TestDriver@123 | SL101-A, SL101-B |
| 102 | driver.slt102@bus.com | TestDriver@123 | SL102-A, SL102-B |
| 103 | driver.slt103@bus.com | TestDriver@123 | SL103-A |
| ... | ... | TestDriver@123 | ... |
| 115 | driver.slt115@bus.com | TestDriver@123 | SL115-A |

---

## Route Categories

### Public Transport (10 routes)
- **100**: Colombo-Kandy (115km, 6 stops)
- **101**: Colombo-Galle (119km, 7 stops)
- **102**: Colombo-Negombo (37km, 5 stops)
- **103**: Colombo-Anuradhapura (205km, 5 stops)
- **104**: Kandy-Nuwara Eliya (58km, 5 stops)
- **105**: Galle-Matara (42km, 5 stops)
- **106**: Colombo-Jaffna (401km, 6 stops) *Longest route*
- **107**: Trincomalee-Batticaloa (97km, 4 stops)
- **111**: Kandy-Badulla (82km, 6 stops)
- **112-115**: Regional routes

### Shuttle Services
- **OFFICE (108)**: Colombo-Negombo Premium (37km, 20 seats)
- **UNIVERSITY (109)**: Colombo-Kandy University Link (115km, 2 buses)
- **SCHOOL (110)**: Colombo-Bambalapitiya Transport (8km, 2 buses)

---

## Bus Distribution

| Service Type | Count | Avg Seats | Bus Types |
|--------------|-------|-----------|-----------|
| PUBLIC | 16 | 42 | AC, NON-AC |
| OFFICE | 1 | 20 | DELUXE |
| UNIVERSITY | 2 | 50 | NON-AC |
| SCHOOL | 2 | 35 | NON-AC |
| **TOTAL** | **22** | **40** | - |

---

## Testing the Nearest Bus Feature

### 1. Route Search
In **user-app > RouteSelectionScreen**:
- Search by Route ID (e.g., "100")
- Search by Route Name (e.g., "Kandy")
- Filters by service type (PUBLIC/SCHOOL/UNIVERSITY/OFFICE)

### 2. GPS Permission
- App requests device location permission
- Uses phone GPS to find nearest buses

### 3. Distance Calculation
- Client-side Haversine formula
- Finds 5 nearest buses by distance
- Ranks by distance (km)

### 4. Live Map
- Shows user marker (blue) + bus markers (secondary)
- Displays nearest 5 buses only
- Real-time socket.io updates

---

## Fare Calculation (LKR)

Fares are calculated by: `distance Ã— rate + min 20 LKR`

| Service Type | Rate/km | Example (100km) |
|--------------|---------|-----------------|
| PUBLIC | 0.65 | 65 LKR |
| SCHOOL | 0.55 | 55 LKR |
| UNIVERSITY | 0.60 | 60 LKR |
| OFFICE | 0.75 | 75 LKR |

---

## Data Schema

### Routes Table (16 entries)
```javascript
{
  routeId: "100",
  routeName: "Colombo - Kandy Express",
  source: "Colombo Fort",
  destination: "Kandy Central",
  distance: 115, // km
  estimatedTime: 180, // minutes
  fare: 75, // LKR
  serviceType: "PUBLIC",
  stops: [
    { stopName: "Colombo Fort", lat: 6.9271, lng: 79.8353, order: 1 },
    ...
  ]
}
```

### Buses Table (22 entries)
```javascript
{
  busId: "SL100-A",
  busName: "High Country Express A",
  registrationNumber: "REG-SL-100-A-2024",
  numberPlate: "SL-NO-1001",
  routeId: "100",
  driverId: ObjectId("... driver reference ..."),
  seatCapacity: 45,
  busType: "AC", // AC, NON-AC, DELUXE, SLEEPER
  serviceType: "PUBLIC",
  isActive: true
}
```

### Users (Drivers) Table (16 entries)
```javascript
{
  email: "driver.slt100@bus.com",
  name: "Drivers Team 100",
  phone: "+94701234567",
  role: "driver",
  isEmailVerified: true,
  isActive: true
}
```

---

## Live Tracking Test Coordinates

### Colombo Metropolitan Region
- Colombo Fort: 6.9271Â°N, 79.8353Â°E
- Mount Lavinia: 6.8455Â°N, 79.8631Â°E
- Panadura: 6.7313Â°N, 79.8917Â°E

### Hill Country
- Kandy: 7.2906Â°N, 80.6328Â°E
- Nuwara Eliya: 6.9497Â°N, 80.7834Â°E
- Badulla: 6.9903Â°N, 81.2717Â°E

### South Coast
- Galle: 6.0535Â°N, 80.2169Â°E
- Matara: 5.9497Â°N, 80.5378Â°E
- Mirissa: 5.9497Â°N, 80.4828Â°E

### North
- Jaffna: 9.6615Â°N, 80.7845Â°E
- Vavuniya: 8.7564Â°N, 80.8119Â°E

---

## Tips for Testing

1. **Map Testing**: Use emulator with GPS mock data or physical device location
2. **Multiple Buses**: Routes 100-101, 109, 110 have multiple buses for distance ranking
3. **Service Type Filter**: Switch between PUBLIC/UNIVERSITY/SCHOOL in Shuttle section
4. **Long Routes**: Route 106 (401km) tests calculations across island
5. **Short Routes**: Route 110 (8km) tests local school transport

---

## Future Enhancements

- [ ] Add live location updates (socket.io) for buses
- [ ] Implement real route history with bookings
- [ ] Add passenger reviews by route
- [ ] Create driver earnings aggregation
- [ ] Set up route notifications for delays

