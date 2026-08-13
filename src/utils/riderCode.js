const crypto = require('crypto');

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PREFIX = 'TMR';
const BLOCK_LENGTH = 4;
const MAX_RETRIES = 12;

function randomBlock() {
  const bytes = crypto.randomBytes(BLOCK_LENGTH);
  let value = '';
  for (let index = 0; index < BLOCK_LENGTH; index += 1) {
    value += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return value;
}

const generateRiderCode = () => `${PREFIX}-${randomBlock()}-${randomBlock()}`;

async function generateUniqueRiderCode(Model) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const riderCode = generateRiderCode();
    // eslint-disable-next-line no-await-in-loop
    if (!(await Model.exists({ riderCode }))) return riderCode;
  }
  throw new Error('Could not generate a unique rider ID');
}

module.exports = { generateRiderCode, generateUniqueRiderCode };
