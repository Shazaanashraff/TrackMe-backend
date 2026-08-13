const {
  defaultEnrollmentConfig,
  validateSchemaUpdate,
  validateEnrollmentResponses
} = require('../../src/utils/enrollmentSchema');

describe('organization enrollment schema', () => {
  test.each([
    ['SCHOOL', 'grade'],
    ['UNIVERSITY', 'studentNumber'],
    ['OFFICE', 'employeeNumber']
  ])('%s defaults to its identity field', (serviceType, requiredKey) => {
    const config = defaultEnrollmentConfig(serviceType);
    expect(config.fields.find((field) => field.key === requiredKey)).toMatchObject({ enabled: true, required: true });
  });

  test('rejects fields outside the service-type catalog', () => {
    expect(validateSchemaUpdate('SCHOOL', [{ key: 'employeeNumber', enabled: true }]).error)
      .toMatch(/Unknown or duplicate/);
  });

  test('validates enabled required fields and discards disabled fields', () => {
    const config = {
      fields: [
        { key: 'grade', label: 'Grade', enabled: true, required: true },
        { key: 'className', label: 'Class', enabled: false, required: false }
      ]
    };
    expect(validateEnrollmentResponses(config, {}).errors).toEqual({ grade: 'Grade is required' });
    expect(validateEnrollmentResponses(config, { grade: ' 7 ', className: 'A' })).toMatchObject({
      valid: false,
      values: { grade: '7' },
      errors: { className: 'This field is not accepted by the organization' }
    });
  });
});
