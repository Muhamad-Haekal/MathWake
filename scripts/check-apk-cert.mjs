import fs from 'node:fs';
import crypto from 'node:crypto';

function inspectApk(apkPath) {
  const fd = fs.openSync(apkPath, 'r');
  const stat = fs.fstatSync(fd);
  const fileSize = stat.size;

  const searchLen = Math.min(fileSize, 65536);
  const tailBuf = Buffer.alloc(searchLen);
  fs.readSync(fd, tailBuf, 0, searchLen, fileSize - searchLen);

  let eocdOffset = -1;
  for (let i = searchLen - 22; i >= 0; i--) {
    if (tailBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = fileSize - searchLen + i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('EOCD not found');

  const cdOffset = tailBuf.readUInt32LE(eocdOffset - (fileSize - searchLen) + 16);

  const magicBuf = Buffer.alloc(16);
  fs.readSync(fd, magicBuf, 0, 16, cdOffset - 16);
  const magic = magicBuf.toString('utf8');
  if (magic !== 'APK Sig Block 42') throw new Error('Not APK Sig Block 42');

  const blockSizeBuf = Buffer.alloc(8);
  fs.readSync(fd, blockSizeBuf, 0, 8, cdOffset - 24);
  const blockSize = Number(blockSizeBuf.readBigUInt64LE(0));

  const blockOffset = cdOffset - blockSize - 8;
  const block = Buffer.alloc(blockSize);
  fs.readSync(fd, block, 0, blockSize, blockOffset + 8);

  let pos = 0;
  const results = [];
  while (pos < block.length - 24) {
    const len = Number(block.readBigUInt64LE(pos));
    pos += 8;
    const id = block.readUInt32LE(pos);
    pos += 4;
    const val = block.subarray(pos, pos + len - 4);
    pos += len - 4;

    if (id === 0x7109871a || id === 0xf05368c0) {
      const scheme = id === 0x7109871a ? 'v2' : 'v3';
      let p = 0;
      const signersLen = val.readUInt32LE(p); p += 4;
      const signerLen = val.readUInt32LE(p); p += 4;
      const signedDataLen = val.readUInt32LE(p); p += 4;
      const signedData = val.subarray(p, p + signedDataLen);

      let sp = 0;
      const digestsLen = signedData.readUInt32LE(sp); sp += 4 + digestsLen;
      const certsLen = signedData.readUInt32LE(sp); sp += 4;
      const certLen = signedData.readUInt32LE(sp); sp += 4;
      const cert = signedData.subarray(sp, sp + certLen);

      const sha256 = crypto.createHash('sha256').update(cert).digest('hex').toUpperCase().match(/../g).join(':');
      const sha1 = crypto.createHash('sha1').update(cert).digest('hex').toUpperCase().match(/../g).join(':');
      const md5 = crypto.createHash('md5').update(cert).digest('hex').toUpperCase().match(/../g).join(':');
      results.push({ scheme, sha256, sha1, md5, certBytes: cert.length });
    }
  }
  fs.closeSync(fd);
  return results;
}

const certs = inspectApk('dist/MathWake-release.apk');
console.log(JSON.stringify(certs, null, 2));

