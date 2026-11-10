import assert from 'node:assert/strict';

const DEFAULT = { kind: 'mathwake', name: 'Suara MathWake', uri: null };
const SYSTEM = { kind: 'system', name: 'Ringtone alarm Android', uri: 'android-system-alarm://default' };
function normalize(value) {
  if (!value || !['mathwake', 'system', 'custom'].includes(value.kind)) return DEFAULT;
  if (value.kind === 'custom' && typeof value.uri !== 'string') return DEFAULT;
  return { kind: value.kind, name: value.name || DEFAULT.name, uri: value.uri || null };
}
function nativeUri(value) {
  const v = normalize(value);
  return v.kind === 'system' ? v.uri : v.kind === 'custom' ? v.uri : 'android-resource://alarm';
}
const store = new Map();
function save(id, value) { store.set(`ringtone:${id}`, JSON.stringify(value)); }
function load(id) { return normalize(JSON.parse(store.get(`ringtone:${id}`) || 'null')); }

save('a', SYSTEM);
save('b', { kind: 'custom', name: 'Nada', uri: 'content://audio/1' });
assert.deepEqual(load('a'), SYSTEM);
assert.deepEqual(load('b'), { kind: 'custom', name: 'Nada', uri: 'content://audio/1' });
assert.deepEqual(load('missing'), DEFAULT);
assert.deepEqual(normalize({ kind: 'custom', name: 'revoked', uri: null }), DEFAULT);
assert.equal(nativeUri(DEFAULT), 'android-resource://alarm');
assert.equal(nativeUri(SYSTEM), 'android-system-alarm://default');
assert.equal(nativeUri(load('b')), 'content://audio/1');
assert.notEqual(store.get('ringtone:a'), store.get('ringtone:b'));
console.log('Hasil: 8 lolos, 0 gagal.');
