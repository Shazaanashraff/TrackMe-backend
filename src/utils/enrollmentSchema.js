const FIELD_CATALOG = Object.freeze({
  SCHOOL: Object.freeze([
    { key: 'grade', label: 'Grade', type: 'text' },
    { key: 'className', label: 'Class', type: 'text' },
    { key: 'admissionNumber', label: 'Admission number', type: 'text' }
  ]),
  UNIVERSITY: Object.freeze([
    { key: 'studentNumber', label: 'Student ID', type: 'text' },
    { key: 'faculty', label: 'Faculty', type: 'text' },
    { key: 'batch', label: 'Batch', type: 'text' }
  ]),
  OFFICE: Object.freeze([
    { key: 'employeeNumber', label: 'Employee ID', type: 'text' },
    { key: 'department', label: 'Department', type: 'text' }
  ])
});

const DEFAULT_REQUIRED = Object.freeze({
  SCHOOL: 'grade',
  UNIVERSITY: 'studentNumber',
  OFFICE: 'employeeNumber'
});

function catalogFor(serviceType) {
  return FIELD_CATALOG[String(serviceType || '').toUpperCase()] || [];
}

function defaultEnrollmentConfig(serviceType) {
  const requiredKey = DEFAULT_REQUIRED[String(serviceType || '').toUpperCase()];
  return {
    schemaVersion: 1,
    fields: catalogFor(serviceType).map((field, index) => ({
      ...field,
      enabled: field.key === requiredKey,
      required: field.key === requiredKey,
      order: index
    }))
  };
}

function normalizedEnrollmentConfig(organization) {
  const defaults = defaultEnrollmentConfig(organization?.serviceType);
  const configured = organization?.enrollmentConfig;
  if (!configured?.fields?.length) return defaults;

  const catalog = new Map(catalogFor(organization.serviceType).map((field) => [field.key, field]));
  const configuredByKey = new Map(
    configured.fields.map((field) => [String(field.key), field.toObject ? field.toObject() : field])
  );

  return {
    schemaVersion: Number(configured.schemaVersion) || 1,
    fields: [...catalog.values()].map((field, index) => {
      const saved = configuredByKey.get(field.key) || {};
      return {
        ...field,
        enabled: Boolean(saved.enabled),
        required: Boolean(saved.enabled && saved.required),
        order: Number.isFinite(Number(saved.order)) ? Number(saved.order) : index
      };
    }).sort((left, right) => left.order - right.order)
  };
}

function validateSchemaUpdate(serviceType, fields) {
  if (!Array.isArray(fields)) return { error: 'fields must be an array' };
  const catalog = new Map(catalogFor(serviceType).map((field) => [field.key, field]));
  const seen = new Set();
  const normalized = [];

  for (const [index, raw] of fields.entries()) {
    const key = String(raw?.key || '');
    if (!catalog.has(key) || seen.has(key)) {
      return { error: `Unknown or duplicate enrollment field: ${key || '(blank)'}` };
    }
    seen.add(key);
    normalized.push({
      ...catalog.get(key),
      enabled: Boolean(raw.enabled),
      required: Boolean(raw.enabled && raw.required),
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index
    });
  }

  for (const [key, field] of catalog) {
    if (!seen.has(key)) normalized.push({ ...field, enabled: false, required: false, order: normalized.length });
  }

  return { fields: normalized.sort((left, right) => left.order - right.order) };
}

function validateEnrollmentResponses(config, responses) {
  const supplied = responses && typeof responses === 'object' && !Array.isArray(responses)
    ? responses
    : {};
  const enabled = config.fields.filter((field) => field.enabled);
  const allowed = new Set(enabled.map((field) => field.key));
  const errors = {};
  const values = {};

  for (const key of Object.keys(supplied)) {
    if (!allowed.has(key)) errors[key] = 'This field is not accepted by the organization';
  }
  for (const field of enabled) {
    const value = String(supplied[field.key] ?? '').trim();
    if (field.required && !value) errors[field.key] = `${field.label} is required`;
    if (value) values[field.key] = value;
  }

  return { valid: Object.keys(errors).length === 0, errors, values };
}

module.exports = {
  FIELD_CATALOG,
  catalogFor,
  defaultEnrollmentConfig,
  normalizedEnrollmentConfig,
  validateSchemaUpdate,
  validateEnrollmentResponses
};
