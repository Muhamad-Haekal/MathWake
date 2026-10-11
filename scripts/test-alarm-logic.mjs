/**
 * Uji logika murni alarm MathWake (tanpa emulator, tanpa Supabase).
 *
 * Menjalankan fungsi aktual dari src/lib/alarms.ts dan src/lib/home-data.ts
 * via strip-tipe Node (Node 22.18+; tidak ada dependensi yang diimpor saat
 * runtime karena kedua modul hanya memakai `import type`).
 *
 * Cakupan: preset +10/+30/+60, tengah malam, once mendatang/lewat/tengah
 * malam (TIDAK bergeser ke besok), keputusan resync once
 * (expired/preserve/fresh + idempotensi), regresi harian/mingguan,
 * validasi form dengan jam injeksi, dan util.
 *
 * Cara pakai:  node scripts/test-alarm-logic.mjs
 */
import {
  dayNumbersToTokens,
  decideOnceSchedule,
  isOncePast,
  nowTime,
  scheduleKindOf,
  shiftTime,
  splitTimeParts,
  validateAlarmForm,
} from '../src/lib/alarms.ts';
import {
  describeAlarmSchedule,
  isOnceExpired,
  nextAlarmFromList,
  nextOccurrenceForAlarm,
  nextOnceOccurrence,
  parseRepeatDays,
} from '../src/lib/home-data.ts';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`GAGAL: ${name}\n  aktual:   ${a}\n  ekspektasi: ${e}`);
  }
}

function fmtLocal(d) {
  if (d === null || d === undefined) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function onceRow(time) {
  return { time, days: [], is_recurring: false };
}

function fullRow(over) {
  return {
    id: 'a1',
    user_id: 'u1',
    time: '06:00:00',
    days: [],
    is_active: true,
    is_recurring: false,
    difficulty: 'sedang',
    question_count: 3,
    preset: null,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

// --- 1. Preset dari waktu acuan (contoh spek: 17:55) ---
check('preset +10 dari 17:55', shiftTime('17:55', 10), '18:05');
check('preset +30 dari 17:55', shiftTime('17:55', 30), '18:25');
check('preset +60 dari 17:55', shiftTime('17:55', 60), '18:55');

// --- 2. Tengah malam ---
check('23:55 +10 lewat tengah malam', shiftTime('23:55', 10), '00:05');
check('00:05 -10 mundur lewat tengah malam', shiftTime('00:05', -10), '23:55');
check('23:00 +60 tepat tengah malam', shiftTime('23:00', 60), '00:00');
check('00:00 -60 ke hari sebelumnya', shiftTime('00:00', -60), '23:00');

// --- 3. Once: masa depan vs lewat (TIDAK ke besok) ---
{
  const now = new Date(2026, 9, 11, 5, 0, 0);
  check('once mendatang hari ini', fmtLocal(nextOnceOccurrence(onceRow('06:00:00'), now)), '2026-10-11 06:00');
}
{
  const now = new Date(2026, 9, 11, 7, 0, 0);
  check('once lewat = null, bukan besok', nextOnceOccurrence(onceRow('06:00:00'), now), null);
}
{
  // Tepat lewat sedetik: 18:20:01 vs 18:20
  const now = new Date(2026, 9, 11, 18, 20, 1);
  check('once tepat lewat = null', nextOnceOccurrence(onceRow('18:20:00'), now), null);
}
{
  // Lewat tengah malam: 23:59 vs 00:05 -> null, bukan besok 00:05
  const now = new Date(2026, 9, 11, 23, 59, 0);
  check('once lewat tengah malam = null', nextOnceOccurrence(onceRow('00:05:00'), now), null);
}
{
  // Lintas tahun tetap hari yang sama jika masih mendatang
  const now = new Date(2026, 11, 31, 23, 0, 0);
  check('once 23:30 di malam tahun baru', fmtLocal(nextOnceOccurrence(onceRow('23:30:00'), now)), '2026-12-31 23:30');
}
check('isOnceExpired lewat', isOnceExpired('06:00:00', new Date(2026, 9, 11, 7, 0, 0)), true);
check('isOnceExpired mendatang', isOnceExpired('06:00:00', new Date(2026, 9, 11, 5, 0, 0)), false);
check('isOncePast lewat', isOncePast('06:00', new Date(2026, 9, 11, 7, 0, 0)), true);

// --- 4. Home melewati once kedaluwarsa ---
{
  const now = new Date(2026, 9, 11, 7, 0, 0);
  const rows = [
    fullRow({ id: 'once-lewat', time: '06:00:00', is_recurring: false }),
    fullRow({ id: 'harian', time: '06:30:00', is_recurring: true, days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }),
  ];
  const best = nextAlarmFromList(rows, now);
  check('home lewati once kedaluwarsa', best?.alarm.id, 'harian');
}
{
  const now = new Date(2026, 9, 11, 7, 0, 0);
  const rows = [fullRow({ id: 'once-lewat', time: '06:00:00', is_recurring: false })];
  check('home tanpa alarm valid = null', nextAlarmFromList(rows, now), null);
}

// --- 5. Keputusan resync once: expired / preserve / fresh ---
{
  // Kejadian lewat -> expired walau ada target tercatat
  check('decide expired', decideOnceSchedule(new Date(2026, 9, 11, 6, 0, 0).toISOString(), null), 'expired');
  check('decide expired tanpa target', decideOnceSchedule(null, null), 'expired');
}
{
  // Target sama dengan kejadian -> preserve (buka ulang & sync berulang idempoten)
  const occ = new Date(2026, 9, 12, 6, 0, 0).getTime();
  check('decide preserve', decideOnceSchedule(new Date(occ).toISOString(), occ), 'preserve');
}
{
  // Tanpa target + kejadian mendatang -> fresh
  const occ = new Date(2026, 9, 12, 6, 0, 0).getTime();
  check('decide fresh tanpa target', decideOnceSchedule(null, occ), 'fresh');
  check('decide fresh target basi', decideOnceSchedule(new Date(2026, 9, 10, 6, 0, 0).toISOString(), occ), 'fresh');
  check('decide fresh target korup', decideOnceSchedule('bukan-tanggal', occ), 'fresh');
}

// --- 6. Regresi harian/mingguan (harus tetap berulang) ---
check('parse token campuran', [...(parseRepeatDays(['Mon', '3', 'Jumat']) ?? [])].sort(), [1, 3, 5]);
{
  // Minggu 11 Okt 2026 -> alarm Senin 07:00 jatuh Senin 12 Okt
  const now = new Date(2026, 9, 11, 9, 0, 0);
  const at = nextOccurrenceForAlarm({ time: '07:00:00', days: ['Mon'] }, now);
  check('mingguan Senin depan', fmtLocal(at), '2026-10-12 07:00');
}
{
  // Harian yang sudah lewat hari ini -> besok (perilaku berulang dipertahankan)
  const now = new Date(2026, 9, 11, 7, 0, 0);
  const at = nextOccurrenceForAlarm({ time: '06:00:00', days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }, now);
  check('harian lewat jadi besok', fmtLocal(at), '2026-10-12 06:00');
}
check('deskripsi once', describeAlarmSchedule({ is_recurring: false, days: ['Mon'] }), 'Sekali saja');
check('deskripsi harian', describeAlarmSchedule({ is_recurring: true, days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }), 'Setiap hari');

// --- 7. Validasi form dengan jam injeksi (tidak flaky) ---
check('custom tanpa hari ditolak', validateAlarmForm({ time: '06:00', days: [], is_recurring: true, is_active: true, difficulty: 'sedang', question_count: 3 }, new Date(2026, 9, 11, 5, 0, 0)), 'Pilih minimal satu hari untuk alarm berulang.');
check('once mendatang sah', validateAlarmForm({ time: '06:00', days: [], is_recurring: false, is_active: true, difficulty: 'sedang', question_count: 3 }, new Date(2026, 9, 11, 5, 0, 0)), null);
check('once lewat ditolak', validateAlarmForm({ time: '06:00', days: [], is_recurring: false, is_active: true, difficulty: 'sedang', question_count: 3 }, new Date(2026, 9, 11, 7, 0, 0)), 'Waktu hari ini sudah lewat. Pilih waktu yang akan datang untuk alarm sekali saja.');
check('jam tak valid ditolak', validateAlarmForm({ time: '25:00', days: [1], is_recurring: true, is_active: true, difficulty: 'sedang', question_count: 3 }, new Date(2026, 9, 11, 5, 0, 0)), 'Jam tidak valid. Gunakan format 24 jam, misalnya 05:30.');

// --- 8. Edit once (waktu baru -> kejadian baru) ---
{
  const now = new Date(2026, 9, 11, 7, 0, 0);
  check('edit once ke waktu mendatang', fmtLocal(nextOnceOccurrence(onceRow('09:00:00'), now)), '2026-10-11 09:00');
}

// --- 9. Util ---
check('kind once', scheduleKindOf(false, []), 'once');
check('kind daily', scheduleKindOf(true, [0, 1, 2, 3, 4, 5, 6]), 'daily');
check('kind custom', scheduleKindOf(true, [1, 3, 5]), 'custom');
check('kind legacy null', scheduleKindOf(null, [1]), 'custom');
check('token hari unik terurut', dayNumbersToTokens([5, 1, 5, 9, -1]), ['Mon', 'Fri']);
check('split HH:MM:SS', splitTimeParts('05:30:00'), { h: 5, m: 30 });
check('split tak valid', splitTimeParts('99:99'), null);
check('nowTime format', /^\d{2}:\d{2}$/.test(nowTime(new Date(2026, 0, 1, 7, 5))), true);

console.log(`\nHasil: ${passed} lolos, ${failed} gagal.`);
process.exit(failed === 0 ? 0 : 1);
