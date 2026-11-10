import assert from 'node:assert/strict';

function normalizeVolume(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
}

function permissionSummary({ notifications, exact, fullScreen }) {
  return {
    notificationsGranted: notifications === 'granted',
    exactAlarmGranted: exact,
    fullScreenGranted: fullScreen,
    ready: notifications === 'granted' && exact && fullScreen,
  };
}

assert.equal(normalizeVolume(-1), 0);
assert.equal(normalizeVolume(0), 0);
assert.equal(normalizeVolume(0.35), 0.35);
assert.equal(normalizeVolume(1), 1);
assert.equal(normalizeVolume(2), 1);
assert.equal(normalizeVolume(Number.NaN), 1);
assert.deepEqual(
  permissionSummary({ notifications: 'granted', exact: true, fullScreen: true }),
  { notificationsGranted: true, exactAlarmGranted: true, fullScreenGranted: true, ready: true },
);
assert.equal(
  permissionSummary({ notifications: 'denied', exact: true, fullScreen: true }).ready,
  false,
);
assert.equal(
  permissionSummary({ notifications: 'granted', exact: false, fullScreen: true }).ready,
  false,
);
assert.equal(
  permissionSummary({ notifications: 'granted', exact: true, fullScreen: false }).ready,
  false,
);

console.log('Hasil: 10 lolos, 0 gagal.');
