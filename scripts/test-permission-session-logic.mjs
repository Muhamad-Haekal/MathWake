import assert from 'node:assert/strict';

function onboarding(status) {
  if (!status.available) return { needs: false, ready: false, actions: [] };
  const actions = [];
  if (!status.notification) actions.push('Aktifkan notifikasi alarm');
  if (!status.exact) actions.push('Atur izin alarm');
  if (!status.fullScreen) actions.push('Permudah akses saat alarm berbunyi');
  return { needs: actions.length > 0, ready: actions.length === 0, actions };
}
assert.deepEqual(onboarding({ available: true, notification: true, exact: true, fullScreen: true }), { needs: false, ready: true, actions: [] });
assert.deepEqual(onboarding({ available: true, notification: false, exact: true, fullScreen: false }), { needs: true, ready: false, actions: ['Aktifkan notifikasi alarm', 'Permudah akses saat alarm berbunyi'] });
assert.deepEqual(onboarding({ available: false, notification: false, exact: false, fullScreen: false }), { needs: false, ready: false, actions: [] });
function activeSession(activeId, requestedId) { return activeId !== null && activeId === requestedId; }
assert.equal(activeSession('a', 'a'), true);
assert.equal(activeSession('a', 'b'), false);
assert.equal(activeSession(null, 'a'), false);
console.log('Hasil: 6 lolos, 0 gagal.');
