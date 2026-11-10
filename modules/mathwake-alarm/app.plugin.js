// MathWake alarm activity config plugin (local file plugin, referenced from
// app.json as "./modules/mathwake-alarm/app.plugin.js").
//
// What it does: marks MainActivity with showWhenLocked + turnScreenOn so the
// full-screen alarm intent from the native MathWakeAlarm receiver can wake
// the device and present the challenge over the lock screen.
//
// The pure `applyMathWakeAlarmManifest` helper is exported for unit testing
// (see the verification notes); the default export is the Expo plugin.

const { withAndroidManifest } = require('@expo/config-plugins');

function applyMathWakeAlarmManifest(manifest) {
  const app = manifest && manifest.application && manifest.application[0];
  if (!app) return false;
  const activities = app.activity || [];
  const main = activities.find(
    (a) =>
      a &&
      a.$ &&
      typeof a.$['android:name'] === 'string' &&
      a.$['android:name'].endsWith('.MainActivity'),
  );
  if (!main) return false;
  main.$['android:showWhenLocked'] = 'true';
  main.$['android:turnScreenOn'] = 'true';
  return true;
}

const withMathWakeAlarm = (config) =>
  withAndroidManifest(config, (cfg) => {
    try {
      applyMathWakeAlarmManifest(cfg.modResults.manifest);
    } catch (e) {
      console.warn('[MathWake][AlarmPlugin] manifest mod failed:', (e && e.message) || e);
    }
    return cfg;
  });

module.exports = withMathWakeAlarm;
module.exports.applyMathWakeAlarmManifest = applyMathWakeAlarmManifest;