const {
  defaultEnrollmentConfig,
  validateSchemaUpdate,
  validateEnrollmentResponses,
  signupFieldsFor,
  validateSignupDetails
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

  test('rejects a symbol-only answer as not a real one, required or not', () => {
    const config = {
      fields: [
        { key: 'grade', label: 'Grade', enabled: true, required: true },
        { key: 'className', label: 'Class', enabled: true, required: false }
      ]
    };
    expect(validateEnrollmentResponses(config, { grade: '%' }).errors).toEqual({
      grade: 'Grade must include a letter or number'
    });
    expect(validateEnrollmentResponses(config, { grade: '7', className: '...' }).errors).toEqual({
      className: 'Class must include a letter or number'
    });
  });
});

describe('signup category details', () => {
  test('school asks for a grade, university and office ask for nothing extra', () => {
    expect(signupFieldsFor('SCHOOL').map((field) => field.key)).toEqual(['grade']);
    expect(signupFieldsFor('UNIVERSITY')).toEqual([]);
    expect(signupFieldsFor('OFFICE')).toEqual([]);
  });

  test('signup keys come from the enrollment catalog, so they can prefill it', () => {
    const [grade] = signupFieldsFor('SCHOOL');
    const catalogGrade = defaultEnrollmentConfig('SCHOOL').fields.find((field) => field.key === 'grade');
    expect(grade).toMatchObject({ key: catalogGrade.key, label: catalogGrade.label });
  });

  test('no category given is valid and stores nothing', () => {
    expect(validateSignupDetails(undefined, undefined)).toMatchObject({ valid: true, category: null, values: {} });
  });

  test('rejects a category outside school, university and office', () => {
    expect(validateSignupDetails('PUBLIC', {})).toMatchObject({
      valid: false,
      errors: { category: 'Choose school, university or office' }
    });
  });

  test('school requires the grade and trims it', () => {
    expect(validateSignupDetails('school', {}).errors).toEqual({ grade: 'Grade is required' });
    expect(validateSignupDetails('school', { grade: ' 7 ' })).toMatchObject({
      valid: true,
      category: 'SCHOOL',
      values: { grade: '7' }
    });
  });

  test('refuses a detail the chosen category never asks for', () => {
    expect(validateSignupDetails('OFFICE', { grade: '7' })).toMatchObject({
      valid: false,
      errors: { grade: 'This field is not asked for this category' }
    });
  });

  test('rejects a symbol-only grade as not a real one', () => {
    expect(validateSignupDetails('school', { grade: '%' })).toMatchObject({
      valid: false,
      errors: { grade: 'Grade must include a letter or number' }
    });
  });
});
