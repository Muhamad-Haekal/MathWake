// The single bundled MathWake alarm source used by both in-app preview and
// the persistent alarm player. Keep this require static so Metro can include
// the WAV asset in every build target.
export const MATHWAKE_ALARM_SOUND = require('../../assets/audio/alarm.wav') as number;
