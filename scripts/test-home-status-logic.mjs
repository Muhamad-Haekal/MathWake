/**
 * Regresi Home: countdown akurat + status alarm aktif dipisah dari jadwal.
 * Cara pakai: node scripts/test-home-status-logic.mjs
 */
import fs from 'node:fs';

import {
  describeAlarmDay,
  formatCountdown,
  msUntilNextMinute,
  nextAlarmFromList,
  resolveHomeSnooze,
} from '../src/lib/home-data.ts';
import { resolveActiveAlarm, SESSION_UNVERIFIED_MAX_AGE_MS } from '../src/lib/alarm-active-state.ts';

let passed = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${name}\n  actual:   ${a}\n  expected: ${e}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0);
const row = (over) => ({
  id: 'x', user_id: 'u', time: '07:00:00', days: null, is_active: true,
  is_recurring: true, difficulty: 'sedang', question_count: 3, preset: null, created_at: '',
  ...over,
});

// --- Countdown: detik dihitung, tidak dibulatkan ke bawah -----------------
check('06:00:30 -> 07:00 = 1 jam (bukan 59 menit)', formatCountdown(at(2026, 10, 20, 7, 0), at(2026, 10, 20, 6, 0, 30)), 'dalam 1 jam');
check('06:59:59 -> 07:00 = 1 menit', formatCountdown(at(2026, 10, 20, 7, 0), at(2026, 10, 20, 6, 59, 59)), 'dalam 1 menit');
check('tepat 07:00 = segera berbunyi', formatCountdown(at(2026, 10, 20, 7, 0), at(2026, 10, 20, 7, 0)), 'segera berbunyi');
check('06:45:00 -> 07:00 = 15 menit', formatCountdown(at(2026, 10, 20, 7, 0), at(2026, 10, 20, 6, 45)), 'dalam 15 menit');
check('2 jam 10 menit', formatCountdown(at(2026, 10, 20, 9, 10), at(2026, 10, 20, 7, 0)), 'dalam 2 jam 10 menit');
check('lewat tengah malam 23:30 -> 05:00 = 5 jam 30 menit', formatCountdown(at(2026, 10, 21, 5, 0), at(2026, 10, 20, 23, 30)), 'dalam 5 jam 30 menit');
check('> 24 jam tidak dibulatkan ke hari saja', formatCountdown(at(2026, 10, 22, 9, 0), at(2026, 10, 20, 7, 0)), 'dalam 2 hari 2 jam');
check('1 hari tepat', formatCountdown(at(2026, 10, 21, 7, 0), at(2026, 10, 20, 7, 0)), 'dalam 1 hari');
check('1 hari 3 menit', formatCountdown(at(2026, 10, 21, 7, 3), at(2026, 10, 20, 7, 0)), 'dalam 1 hari 3 menit');
check('tick menit berikutnya dari :30 = 30 dtk', msUntilNextMinute(at(2026, 10, 20, 7, 0, 30)), 30000);

// --- Countdown memakai jadwal yang benar (berulang, hari aktif, sekali) ---
const tue = at(2026, 10, 20, 7, 30); // Selasa
const weekly = row({ id: 'w', time: '07:00:00', days: ['Mon'] });
const nextW = nextAlarmFromList([weekly], tue);
check('mingguan Senin dari Selasa -> Senin depan', nextW.at.getTime(), at(2026, 10, 26, 7, 0).getTime());
check('countdown mingguan 5 hari 23 jam 30 menit', formatCountdown(nextW.at, tue), 'dalam 5 hari 23 jam 30 menit');
check('label hari memakai now yang diberikan', describeAlarmDay(nextW.at, tue), 'Senin');
const daily = row({ id: 'd', time: '07:00:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] });
check('harian yang lewat -> besok', describeAlarmDay(nextAlarmFromList([daily], tue).at, tue), 'Besok');
const onceGone = row({ id: 'o', time: '07:00:00', is_recurring: false });
check('sekali jalan yang lewat tidak bergeser ke besok', nextAlarmFromList([onceGone], tue), null);
const onceLater = row({ id: 'o2', time: '08:00:00', is_recurring: false });
check('sekali jalan nanti = hari ini', describeAlarmDay(nextAlarmFromList([onceLater], tue).at, tue), 'Hari ini');

// --- Snooze: enabled schedule remains visible with native due countdown ----
const snoozedOnce = row({ id: 'once-snoozed', time: '07:00:00', is_recurring: false });
const nativeSnooze = (over = {}) => ({
  alarmId: snoozedOnce.id, eventId: 'mw1:source:child', triggerAtMs: tue.getTime() + 5 * 60_000,
  generation: 'child-generation', state: 'scheduled', firedAtMs: null, sessionId: 'child', revision: 0,
  isSnooze: true, snoozeMinutes: 5, sourceEventId: 'source-event', sourceGeneration: 'source-generation',
  ...over,
});
check('one-shot expired schedule still appears home during snooze',
  nextAlarmFromList([snoozedOnce], tue), null);
check('enabled alarm joins its scheduled snooze and interval',
  resolveHomeSnooze([nativeSnooze()], [snoozedOnce], tue),
  { alarm: snoozedOnce, triggerAtMs: tue.getTime() + 5 * 60_000, snoozeMinutes: 5 });
check('pending snooze remains visible when one-time schedule is inactive',
  resolveHomeSnooze([nativeSnooze()], [{ ...snoozedOnce, is_active: false }], tue).snoozeMinutes, 5);
check('expired snooze is not displayed as pending', resolveHomeSnooze([nativeSnooze({ triggerAtMs: tue.getTime() })], [snoozedOnce], tue), null);
check('invalid snooze interval is not displayed', resolveHomeSnooze([nativeSnooze({ snoozeMinutes: 7 })], [snoozedOnce], tue), null);

// --- Status aktif: hanya dari bukti nyata --------------------------------
const nowMs = at(2026, 10, 20, 7, 5).getTime();
const session = (alarmId, ageMs) => ({ alarmId, difficulty: 'sulit', questionCount: 5, timeLimitSeconds: 0, maxMistakes: 0, startedAt: nowMs - ageMs });

check('tanpa ringer & tanpa sesi = tidak berbunyi (jadwal dekat tidak dihitung)',
  resolveActiveAlarm({ nativeActiveId: null, session: null, jsAudioPlaying: false, nowMs }), null);
check('ringer native aktif = berbunyi terverifikasi',
  resolveActiveAlarm({ nativeActiveId: 'a', session: null, jsAudioPlaying: false, nowMs }),
  { alarmId: 'a', session: null, verified: true });
check('ringer native + sesi cocok membawa parameter sesi',
  resolveActiveAlarm({ nativeActiveId: 'a', session: session('a', 1000), jsAudioPlaying: false, nowMs }).session.questionCount, 5);
check('sesi alarm lain tidak dipakai untuk ringer native',
  resolveActiveAlarm({ nativeActiveId: 'a', session: session('b', 1000), jsAudioPlaying: false, nowMs }).session, null);
check('audio JS berbunyi = terverifikasi walau sesi lama',
  resolveActiveAlarm({ nativeActiveId: null, session: session('a', SESSION_UNVERIFIED_MAX_AGE_MS * 3), jsAudioPlaying: true, nowMs }).verified, true);
check('sesi baru tanpa ringer = tantangan belum selesai (tidak diklaim berbunyi)',
  resolveActiveAlarm({ nativeActiveId: null, session: session('a', 60000), jsAudioPlaying: false, nowMs }),
  { alarmId: 'a', session: session('a', 60000), verified: false });
check('sesi basi tanpa ringer disembunyikan',
  resolveActiveAlarm({ nativeActiveId: null, session: session('a', SESSION_UNVERIFIED_MAX_AGE_MS + 1), jsAudioPlaying: false, nowMs }), null);

// --- Struktur: aksi Home tidak bergantung pada jadwal aktif --------------
const card = fs.readFileSync('src/components/home/next-alarm-card.tsx', 'utf8');
const home = fs.readFileSync('src/app/(app)/index.tsx', 'utf8');
const useAlarms = fs.readFileSync('src/hooks/use-alarms.ts', 'utf8');
check('kartu aktif dirender dari status aktif, bukan baris jadwal', card.includes('if (active) {'), true);
check('kartu jadwal tidak lagi menampilkan "sedang berbunyi"', card.includes('Alarm sedang berbunyi — Kerjakan soal'), false);
check('Home memakai resolveActiveAlarm', home.includes('resolveActiveAlarm('), true);
check('Home tidak memakai data.nextAlarm basi', home.includes('nextAlarm={data.nextAlarm}'), false);
check('Home tidak membersihkan sesi', home.includes('clearAlarmSession'), false);
check('resync expired melewati alarm yang masih berbunyi/bersesi', useAlarms.includes('!inFlight.has(id)'), true);

// --- Home tidak lagi mengambil atau merender Morning Routine -------------
const homeData = fs.readFileSync('src/lib/home-data.ts', 'utf8');
const todayStats = fs.readFileSync('src/components/home/today-stats.tsx', 'utf8');
const alarmEditor = fs.readFileSync('src/components/alarms/alarm-editor-modal.tsx', 'utf8');
const alarmsScreen = fs.readFileSync('src/app/(app)/alarms.tsx', 'utf8');
check('Home tidak merender RoutineSummary', home.includes('RoutineSummary'), false);
check('Home data tidak meng-query routine_items', homeData.includes("from('routine_items')"), false);
check('Home data tetap meng-query alarm_logs', homeData.includes("from('alarm_logs')"), true);
check('Home data tetap meng-query attempts', homeData.includes("from('attempts')"), true);
check('TodayStats tidak memiliki statistik Routine', todayStats.includes('routinesDone'), false);
check('editor alarm tidak memuat Routine', alarmEditor.includes('listRoutineSummary'), false);
check('editor alarm tetap memuat validasi form', alarmEditor.includes('validateAlarmForm'), true);
check('daftar alarm menonjolkan jam dan status tiap alarm', alarmsScreen.includes('styles.rowTime') && alarmsScreen.includes('statusPill'), true);
check('daftar alarm mempertahankan kontrol toggle native', alarmsScreen.includes('<Switch') && alarmsScreen.includes('onValueChange={onToggle}'), true);
check('toggle alarm memakai guard once-lewat', alarmsScreen.includes('canEnableAlarm(alarm)'), true);
check('saklar once-lewat tidak dapat dinyalakan', alarmsScreen.includes('disabled={busy || enableBlocked}'), true);
check('once-lewat mengarahkan pengguna mengubah jam', alarmsScreen.includes('ubah jam untuk menyalakan lagi'), true);
check('kegagalan mutasi terlihat walau daftar terisi', alarmsScreen.includes('error && alarms.length > 0'), true);
check('empty state mengarah ke aksi tambah alarm', alarmsScreen.includes('onPress={openCreate}'), true);

console.log(`\nHasil: ${passed} lolos, 0 gagal.`);
