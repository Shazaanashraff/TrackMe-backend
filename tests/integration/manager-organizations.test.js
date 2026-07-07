const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Organization = require('../../src/models/Organization');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Managers are categorised by serviceType (PUBLIC / SCHOOL / UNIVERSITY / OFFICE).
// The private service types must belong to an Organization (school/university/office),
// which the super admin can create and pick. PUBLIC managers have no organization.

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

let superAdminToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const superAdmin = await User.create({
    name: 'Super Admin', email: `sa-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'super-admin', isEmailVerified: true, isActive: true
  });
  superAdminToken = await loginAs(superAdmin.email, 'P@ssw0rd!');
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const auth = () => ['Authorization', `Bearer ${superAdminToken}`];

describe('Organizations', () => {
  it('creates an organization and lists it filtered by service type', async () => {
    const created = await request(app)
      .post('/api/super-admin/organizations')
      .set(...auth())
      .send({ name: 'Royal College', serviceType: 'SCHOOL' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'Royal College', serviceType: 'SCHOOL' });

    // A different service type should not surface it.
    const uniList = await request(app)
      .get('/api/super-admin/organizations?serviceType=UNIVERSITY')
      .set(...auth());
    expect(uniList.body.data.find((o) => o.name === 'Royal College')).toBeUndefined();

    const schoolList = await request(app)
      .get('/api/super-admin/organizations?serviceType=SCHOOL')
      .set(...auth());
    expect(schoolList.body.data.map((o) => o.name)).toContain('Royal College');
  });

  it('rejects a case-insensitive duplicate within the same service type', async () => {
    await Organization.create({ name: 'Ananda College', serviceType: 'SCHOOL' });
    const dup = await request(app)
      .post('/api/super-admin/organizations')
      .set(...auth())
      .send({ name: 'ananda college', serviceType: 'SCHOOL' });
    expect(dup.status).toBe(409);
  });

  it('rejects PUBLIC as an organization service type', async () => {
    const res = await request(app)
      .post('/api/super-admin/organizations')
      .set(...auth())
      .send({ name: 'Nope', serviceType: 'PUBLIC' });
    expect(res.status).toBe(400);
  });
});

describe('Manager service + organization', () => {
  it('creates a PUBLIC manager with no organization', async () => {
    const res = await request(app)
      .post('/api/super-admin/managers')
      .set(...auth())
      .send({ name: 'Public Mgr', email: `pub-${Date.now()}@t.com`, password: 'P@ssw0rd!', serviceType: 'PUBLIC' });
    expect(res.status).toBe(201);
    expect(res.body.data.serviceType).toBe('PUBLIC');
    expect(res.body.data.organization).toBeNull();
  });

  it('creates a SCHOOL manager linked to an organization', async () => {
    const org = await Organization.create({ name: 'Trinity College', serviceType: 'SCHOOL' });
    const res = await request(app)
      .post('/api/super-admin/managers')
      .set(...auth())
      .send({
        name: 'School Mgr', email: `sch-${Date.now()}@t.com`, password: 'P@ssw0rd!',
        serviceType: 'SCHOOL', organizationId: org._id.toString()
      });
    expect(res.status).toBe(201);
    expect(res.body.data.serviceType).toBe('SCHOOL');
    expect(res.body.data.organization).toMatchObject({ name: 'Trinity College' });
  });

  it('rejects a SCHOOL manager with no organization', async () => {
    const res = await request(app)
      .post('/api/super-admin/managers')
      .set(...auth())
      .send({ name: 'Bad Mgr', email: `bad-${Date.now()}@t.com`, password: 'P@ssw0rd!', serviceType: 'SCHOOL' });
    expect(res.status).toBe(400);
  });

  it('rejects an organization whose service type does not match the manager', async () => {
    const org = await Organization.create({ name: 'Some Office', serviceType: 'OFFICE' });
    const res = await request(app)
      .post('/api/super-admin/managers')
      .set(...auth())
      .send({
        name: 'Mismatch Mgr', email: `mis-${Date.now()}@t.com`, password: 'P@ssw0rd!',
        serviceType: 'SCHOOL', organizationId: org._id.toString()
      });
    expect(res.status).toBe(400);
  });

  it('updates a PUBLIC manager to a UNIVERSITY manager with an organization', async () => {
    const create = await request(app)
      .post('/api/super-admin/managers')
      .set(...auth())
      .send({ name: 'Switch Mgr', email: `sw-${Date.now()}@t.com`, password: 'P@ssw0rd!', serviceType: 'PUBLIC' });
    const managerId = create.body.data._id;
    const org = await Organization.create({ name: 'Uni of Colombo', serviceType: 'UNIVERSITY' });

    const res = await request(app)
      .put(`/api/super-admin/managers/${managerId}`)
      .set(...auth())
      .send({ serviceType: 'UNIVERSITY', organizationId: org._id.toString() });
    expect(res.status).toBe(200);
    expect(res.body.data.serviceType).toBe('UNIVERSITY');
    expect(res.body.data.organization).toMatchObject({ name: 'Uni of Colombo' });
  });
});
