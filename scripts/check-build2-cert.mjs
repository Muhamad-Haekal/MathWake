import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Get redirected URL for build 2
function getRedirect(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(res.headers.location);
      } else {
        resolve(url);
      }
    }).on('error', reject);
  });
}

function fetchRange(url, start, end) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Range: `bytes=${start}-${end}` } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function run() {
  const step1 = await getRedirect('https://expo.dev/artifacts/eas/LY9BBxp6uCcW3iErT5w6FN22FR_C0P495amRlyOau0I.apk');
  const finalUrl = await getRedirect(step1);
  console.log('Final URL obtained.');

  const fileSize = 111400661;
  const tailLen = 65536;
  const tailBuf = await fetchRange(finalUrl, fileSize - tailLen, fileSize - 1);

  let eocdOffset = -1;
  for (let i = tailBuf.length - 22; i >= 0; i--) {
    if (tailBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  const cdOffset = tailBuf.readUInt32LE(eocdOffset + 16);
  console.log('Build 2 CD offset:', cdOffset);

  const magicBuf = await fetchRange(finalUrl, cdOffset - 24, cdOffset - 1);
  const blockSize = Number(magicBuf.readBigUInt64LE(0));
  const magic = magicBuf.subarray(8).toString('utf8');
  console.log('Magic:', magic, 'Block size:', blockSize);

  const block = await fetchRange(finalUrl, cdOffset - blockSize - 8, cdOffset - 1);
  const val = block.subarray(8); // skip size

  let pos = 0;
  while (pos < val.length - 24) {
    const len = Number(val.readBigUInt64LE(pos));
    pos += 8;
    const id = val.readUInt32LE(pos);
    pos += 4;
    const data = val.subarray(pos, pos + len - 4);
    pos += len - 4;

    if (id === 0x7109871a || id === 0xf05368c0) {
      let p = 0;
      const signersLen = data.readUInt32LE(p); p += 4;
      const signerLen = data.readUInt32LE(p); p += 4;
      const signedDataLen = data.readUInt32LE(p); p += 4;
      const signedData = data.subarray(p, p + signedDataLen);

      let sp = 0;
      const digestsLen = signedData.readUInt32LE(sp); sp += 4 + digestsLen;
      const certsLen = signedData.readUInt32LE(sp); sp += 4;
      const certLen = signedData.readUInt32LE(sp); sp += 4;
      const cert = signedData.subarray(sp, sp + certLen);

      const sha256 = crypto.createHash('sha256').update(cert).digest('hex').toUpperCase().match(/../g).join(':');
      const sha1 = crypto.createHash('sha1').update(cert).digest('hex').toUpperCase().match(/../g).join(':');
      console.log('BUILD 2 SIGNATURE:');
      console.log('Scheme:', id === 0x7109871a ? 'v2' : 'v3');
      console.log('SHA-256:', sha256);
      console.log('SHA-1:  ', sha1);
    }
  }
}

run().catch(console.error);

