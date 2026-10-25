const Identity = require('../models/Identity');
const { modelForRole } = require('../utils/accountRegistry');
const { issueTokensForUser } = require('../utils/tokens');
const { userPayload, hasPassword } = require('../utils/accountPayload');
const { revokeSessions } = require('../utils/sessions');
const { ACCOUNT_CODE_SELECT, issueAccountCode, consumeAccountCode } = require('../utils/accountCode');
const { sendAccountCodeEmail, sendPasswordChangedEmail } = require('../utils/accountEmails');
const accountDeletion = require('../services/accountDeletion');

// Signed-in account actions from the rider app's Profile: change password and
// delete account, each confirmed with a code emailed to the account. Both act
// on the whole login (the Identity), so they work from a switched-in managed
// profile too. See docs/modules/AUTH.md "Account actions".

const shouldEchoDevOtp = () =>
  process.env.ENABLE_DEV_OTP_ECHO === 'true' && process.env.NODE_ENV !== 'production';

const loadIdentity = (req, extraSelect = '') =>
  req.identityId ? Identity.findById(req.identityId).select(`+password ${ACCOUNT_CODE_SELECT} ${extraSelect}`.trim()) : null;

// @desc    Email a code that confirms a password change or account deletion
// @route   POST /api/auth/account-code   { purpose }
// @access  Private (rider)
exports.requestAccountCode = async (req, res, next) => {
  try {
    const { purpose } = req.body;
    const identity = await loadIdentity(req);
    if (!identity) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    if (purpose === 'CHANGE_PASSWORD' && !hasPassword(identity)) {
      return res.status(409).json({
        success: false,
        code: 'NO_PASSWORD',
        message: 'This account signs in with Google, so it has no password to change.'
      });
    }

    const code = await issueAccountCode(identity, purpose);
    const emailSent = await sendAccountCodeEmail(identity.email, code, purpose);

    if (emailSent) {
      return res.status(200).json({ success: true, message: 'We sent a 6-digit code to your email.', email: identity.email });
    }
    if (shouldEchoDevOtp()) {
      return res.status(200).json({
        success: true,
        message: 'Email service unavailable. Use development OTP in non-production environments.',
        email: identity.email,
        developmentOtp: code
      });
    }
    return res.status(502).json({ success: false, message: 'We could not send the code right now. Please try again shortly.' });
  } catch (error) {
    next(error);
  }
};

// @desc    Change the password with an emailed code; this device stays signed in
// @route   POST /api/auth/change-password   { code, password }
// @access  Private (rider)
exports.changePassword = async (req, res, next) => {
  try {
    const identity = await loadIdentity(req);
    if (!identity) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }
    if (!hasPassword(identity)) {
      return res.status(409).json({
        success: false,
        code: 'NO_PASSWORD',
        message: 'This account signs in with Google, so it has no password to change.'
      });
    }

    const result = await consumeAccountCode(identity, 'CHANGE_PASSWORD', req.body.code);
    if (!result.ok) {
      return res.status(400).json({ success: false, code: 'INVALID_CODE', message: result.message });
    }

    identity.password = req.body.password;
    identity.isProvisional = false;
    await identity.save();

    // Every session of every role this login holds ends, then this device gets a
    // fresh pair. The profile is re-read after the revoke so the new token carries
    // the bumped sessionVersion.
    const io = req.app.get('io');
    await revokeSessions(identity._id, { io, keepSocketsOf: req.user._id });
    const model = modelForRole(req.user.role);
    const fresh = await model.findById(req.user._id).select('-avatarUrl');
    const tokens = await issueTokensForUser(fresh, req.user.role);

    await sendPasswordChangedEmail(identity.email);

    return res.status(200).json({
      success: true,
      message: 'Password changed. Other devices were signed out.',
      ...tokens,
      user: userPayload(fresh, req.user.role, identity)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Schedule the rider account for deletion, confirmed with an emailed code
// @route   POST /api/auth/delete-account   { code }
// @access  Private (rider)
exports.deleteAccount = async (req, res, next) => {
  try {
    const identity = await loadIdentity(req);
    if (!identity) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    const result = await consumeAccountCode(identity, 'DELETE_ACCOUNT', req.body.code);
    if (!result.ok) {
      return res.status(400).json({ success: false, code: 'INVALID_CODE', message: result.message });
    }

    const scheduled = await accountDeletion.scheduleDeletion({ identity, io: req.app.get('io') });
    if (scheduled.error) {
      const { status, ...body } = scheduled.error;
      return res.status(status).json({ success: false, ...body });
    }

    return res.status(200).json({
      success: true,
      message: 'Your account will be deleted. Sign in before then to keep it.',
      purgeAt: scheduled.purgeAt
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Keep an account that is waiting to be deleted
// @route   POST /api/auth/delete-account/cancel
// @access  Private (rider, account holder)
exports.cancelDeletion = async (req, res, next) => {
  try {
    const identity = await loadIdentity(req);
    const cancelled = await accountDeletion.cancelDeletion({ primary: req.user, identity, io: req.app.get('io') });
    if (cancelled.error) {
      const { status, ...body } = cancelled.error;
      return res.status(status).json({ success: false, ...body });
    }

    return res.status(200).json({
      success: true,
      message: 'Your account was kept.',
      restoredEnrollments: cancelled.restoredCount,
      user: userPayload(cancelled.user, 'user', identity)
    });
  } catch (error) {
    next(error);
  }
};
