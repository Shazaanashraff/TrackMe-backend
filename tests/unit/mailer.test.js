// Resend is primary, SMTP (nodemailer) is the fallback. Neither provider is ever
// contacted for real: both modules are mocked.
const mockResendSend = jest.fn();
const mockSmtpSend = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSmtpSend }));

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockResendSend } }))
}));
jest.mock('nodemailer', () => ({ createTransport: (...args) => mockCreateTransport(...args) }));

const { sendMail, isEmailConfigured } = require('../../src/utils/mailer');

const MESSAGE = { to: 'rider@example.com', subject: 'Hi', html: '<p>Hi</p>' };
const SMTP_ENV = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'noreply@pingo.lk',
  SMTP_PASS: 'secret'
};

const ENV_KEYS = [
  'RESEND_API_KEY', 'RESEND_FROM',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'
];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; delete process.env[k]; });
  mockResendSend.mockReset();
  mockSmtpSend.mockReset();
  mockCreateTransport.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
  jest.restoreAllMocks();
});

describe('mailer', () => {
  it('returns false and contacts no provider when nothing is configured', async () => {
    expect(isEmailConfigured()).toBe(false);
    expect(await sendMail(MESSAGE)).toBe(false);
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it('sends through Resend with the configured sender and skips SMTP', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM = 'Pingo <no-reply@pingo.lk>';
    Object.assign(process.env, SMTP_ENV);
    mockResendSend.mockResolvedValue({ data: { id: 'abc' }, error: null });

    expect(await sendMail(MESSAGE)).toBe(true);
    expect(mockResendSend).toHaveBeenCalledWith({ from: 'Pingo <no-reply@pingo.lk>', ...MESSAGE });
    expect(mockSmtpSend).not.toHaveBeenCalled();
  });

  it('falls back to SMTP when Resend returns an error', async () => {
    process.env.RESEND_API_KEY = 're_test';
    Object.assign(process.env, SMTP_ENV);
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });
    mockSmtpSend.mockResolvedValue({ messageId: 'm1' });

    expect(await sendMail(MESSAGE)).toBe(true);
    expect(mockSmtpSend).toHaveBeenCalledWith({ from: 'noreply@pingo.lk', ...MESSAGE });
  });

  it('falls back to SMTP when Resend throws', async () => {
    process.env.RESEND_API_KEY = 're_test';
    Object.assign(process.env, SMTP_ENV);
    mockResendSend.mockRejectedValue(new Error('network down'));
    mockSmtpSend.mockResolvedValue({ messageId: 'm2' });

    expect(await sendMail(MESSAGE)).toBe(true);
    expect(mockSmtpSend).toHaveBeenCalledTimes(1);
  });

  it('uses SMTP alone when Resend is not configured, honouring SMTP_FROM and port 465 TLS', async () => {
    Object.assign(process.env, SMTP_ENV, { SMTP_PORT: '465', SMTP_FROM: 'Pingo <no-reply@pingo.lk>' });
    mockSmtpSend.mockResolvedValue({ messageId: 'm3' });

    expect(isEmailConfigured()).toBe(true);
    expect(await sendMail(MESSAGE)).toBe(true);
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 465, secure: true })
    );
    expect(mockSmtpSend).toHaveBeenCalledWith({ from: 'Pingo <no-reply@pingo.lk>', ...MESSAGE });
  });

  it('returns false instead of throwing when every provider fails', async () => {
    process.env.RESEND_API_KEY = 're_test';
    Object.assign(process.env, SMTP_ENV);
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'nope' } });
    mockSmtpSend.mockRejectedValue(new Error('auth failed'));

    await expect(sendMail(MESSAGE)).resolves.toBe(false);
  });

  it('treats a partial SMTP config as not configured', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    expect(isEmailConfigured()).toBe(false);
    expect(await sendMail(MESSAGE)).toBe(false);
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });
});
