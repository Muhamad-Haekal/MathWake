import fs from 'node:fs';
import zlib from 'node:zlib';

function readApkManifest(apkPath) {
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
  const cdOffset = tailBuf.readUInt32LE(eocdOffset - (fileSize - searchLen) + 16);
  const cdSize = tailBuf.readUInt32LE(eocdOffset - (fileSize - searchLen) + 12);
  const cdEntries = tailBuf.readUInt16LE(eocdOffset - (fileSize - searchLen) + 10);

  const cdBuf = Buffer.alloc(cdSize);
  fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

  let p = 0;
  let manifestEntry = null;
  while (p < cdSize) {
    if (cdBuf.readUInt32LE(p) !== 0x02014b50) break;
    const compression = cdBuf.readUInt16LE(p + 10);
    const compSize = cdBuf.readUInt32LE(p + 20);
    const uncompSize = cdBuf.readUInt32LE(p + 24);
    const nameLen = cdBuf.readUInt16LE(p + 28);
    const extraLen = cdBuf.readUInt16LE(p + 30);
    const commentLen = cdBuf.readUInt16LE(p + 32);
    const localHeaderOffset = cdBuf.readUInt32LE(p + 42);
    const name = cdBuf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (name === 'AndroidManifest.xml') {
      manifestEntry = { compression, compSize, uncompSize, localHeaderOffset };
      break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (!manifestEntry) throw new Error('AndroidManifest.xml not found in APK');

  // Read local header to get to actual data
  const localHeaderBuf = Buffer.alloc(30);
  fs.readSync(fd, localHeaderBuf, 0, 30, manifestEntry.localHeaderOffset);
  const localNameLen = localHeaderBuf.readUInt16LE(26);
  const localExtraLen = localHeaderBuf.readUInt16LE(28);
  const dataOffset = manifestEntry.localHeaderOffset + 30 + localNameLen + localExtraLen;

  const compressedData = Buffer.alloc(manifestEntry.compSize);
  fs.readSync(fd, compressedData, 0, manifestEntry.compSize, dataOffset);
  fs.closeSync(fd);

  const manifestData = manifestEntry.compression === 8
    ? zlib.inflateRawSync(compressedData)
    : compressedData;

  // Simple AXML string pool extractor
  // Header: 0x00080003 (AXML magic)
  const magic = manifestData.readUInt32LE(0);
  console.log('AXML Magic:', '0x' + magic.toString(16));

  // Chunk 1 is String Pool (magic 0x001c0001)
  const spMagic = manifestData.readUInt32LE(8);
  const spSize = manifestData.readUInt32LE(12);
  const stringCount = manifestData.readUInt32LE(16);
  const isUtf8 = (manifestData.readUInt32LE(28) & (1 << 8)) !== 0;

  console.log('String pool size:', spSize, 'Count:', stringCount, 'isUtf8:', isUtf8);

  const strings = [];
  const stringOffsets = [];
  for (let i = 0; i < stringCount; i++) {
    stringOffsets.push(manifestData.readUInt32LE(36 + i * 4));
  }
  const stringsStart = 8 + manifestData.readUInt32LE(28 + 4);

  for (let i = 0; i < stringCount; i++) {
    const strOffset = stringsStart + stringOffsets[i];
    if (isUtf8) {
      let len = manifestData.readUInt8(strOffset);
      let lenOffset = 1;
      if (len & 0x80) { len = ((len & 0x7f) << 8) | manifestData.readUInt8(strOffset + 1); lenOffset = 2; }
      let byteLen = manifestData.readUInt8(strOffset + lenOffset);
      let byteLenOffset = 1;
      if (byteLen & 0x80) { byteLen = ((byteLen & 0x7f) << 8) | manifestData.readUInt8(strOffset + lenOffset + 1); byteLenOffset = 2; }
      const str = manifestData.subarray(strOffset + lenOffset + byteLenOffset, strOffset + lenOffset + byteLenOffset + byteLen).toString('utf8');
      strings.push(str);
    } else {
      let len = manifestData.readUInt16LE(strOffset);
      let lenOffset = 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | manifestData.readUInt16LE(strOffset + 2); lenOffset = 4; }
      const str = manifestData.subarray(strOffset + lenOffset, strOffset + lenOffset + len * 2).toString('utf16le');
      strings.push(str);
    }
  }

  return { strings };
}

const res = readApkManifest('dist/MathWake-release.apk');
const interesting = res.strings.filter(s =>
  s.includes('MathWake') || s.includes('com.anonymous') || s.includes('version') ||
  s.includes('permission') || s.includes('1.0.0') || s.includes('USE_FULL_SCREEN_INTENT')
);
console.log('Interesting manifest strings:');
console.log(interesting);

