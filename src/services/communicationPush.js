const { Expo } = require('expo-server-sdk');
const { PushDelivery } = require('../models/Communication');
const User = require('../models/User');
const Driver = require('../models/Driver');
const expo = new Expo();
async function removeToken(token) {
  await Promise.all([User.updateMany({ pushTokens: token }, { $pull: { pushTokens: token } }), Driver.updateMany({ pushTokens: token }, { $pull: { pushTokens: token } })]);
}
// Leases recover after worker crashes. Expo is at-least-once: stable event IDs let
// clients deduplicate. A ticket/receipt is never a read or an absence acknowledgment.
async function dispatchPush() {
  for (let n = 0; n < 50; n++) {
    const job = await PushDelivery.findOneAndUpdate({ state: { $in: ['pending', 'receipts'] }, nextAttempt: { $lte: new Date() },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date() } }] },
    { $set: { leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { new: true });
    if (!job) break;
    try {
      if (!job.devices.length) {
        const account = await (job.role === 'driver' ? Driver : User).findById(job.recipientId).select('pushTokens').lean();
        job.devices = [...new Set(account?.pushTokens || [])].filter(Expo.isExpoPushToken).map(token => ({ token, state: 'pending' }));
      }
      const pending = job.devices.filter(d => d.state === 'pending');
      for (let offset = 0; offset < pending.length; offset += 100) {
        const batch = pending.slice(offset, offset + 100);
        const tickets = await expo.sendPushNotificationsAsync(batch.map(d => ({ to: d.token, title: job.title, body: job.body, sound: 'default', channelId: 'communications', data: job.data })));
        for (let i = 0; i < batch.length; i++) {
          const ticket = tickets[i];
          if (ticket.status === 'ok') { batch[i].ticketId = ticket.id; batch[i].state = 'receipts'; }
          else if (ticket.details?.error === 'DeviceNotRegistered') { await removeToken(batch[i].token); batch[i].state = 'invalid'; }
          else if (['InvalidCredentials', 'MessageTooBig', 'MismatchSenderId'].includes(ticket.details?.error)) { batch[i].state = 'failed'; job.error = ticket.details.error; }
        }
        await job.save();
      }
      if (!pending.length) {
        const waiting = job.devices.filter(d => d.state === 'receipts');
        if (waiting.length) {
          const receipts = await expo.getPushNotificationReceiptsAsync(waiting.map(d => d.ticketId));
          for (const device of waiting) {
            const receipt = receipts[device.ticketId];
            if (!receipt) continue;
            if (receipt.status === 'ok') device.state = 'accepted';
            else if (receipt.details?.error === 'DeviceNotRegistered') { await removeToken(device.token); device.state = 'invalid'; }
            else { device.state = 'failed'; job.error = receipt.details?.error || 'Push receipt error'; }
          }
        }
      }
      job.state = job.devices.some(d => d.state === 'pending') ? 'pending' : job.devices.some(d => d.state === 'receipts') ? 'receipts' : 'complete';
      if (job.attempts >= 12 && job.state !== 'complete') { job.state = 'failed'; job.error = 'Push retries exhausted'; }
      job.nextAttempt = new Date(Date.now() + (job.state === 'receipts' ? 15 * 60000 : Math.min(3600000, 1000 * 2 ** job.attempts)));
    } catch (error) {
      job.error = 'Push transport unavailable';
      job.nextAttempt = new Date(Date.now() + Math.min(3600000, 1000 * 2 ** job.attempts));
      if (job.attempts >= 12) job.state = 'failed';
    }
    job.leaseUntil = null; await job.save();
  }
}
module.exports = { dispatchPush, removeToken };
