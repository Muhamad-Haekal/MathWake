import assert from 'node:assert/strict';

const { dayPartForHour, greetingForDate, greetingForOccurrence } = await import('../src/lib/greeting.ts');

const at = (h, m = 0) => new Date(2026, 10, 10, h, m, 0);

// Every boundary minute, both sides.
const cases = [
  [0, 0, 'Selamat malam!'],
  [4, 59, 'Selamat malam!'],
  [5, 0, 'Selamat pagi!'],
  [10, 59, 'Selamat pagi!'],
  [11, 0, 'Selamat siang!'],
  [14, 59, 'Selamat siang!'],
  [15, 0, 'Selamat sore!'],
  [17, 59, 'Selamat sore!'],
  [18, 0, 'Selamat malam!'],
  [23, 59, 'Selamat malam!'],
];
for (const [h, m, expected] of cases) {
  assert.equal(greetingForDate(at(h, m)), expected, `${h}:${String(m).padStart(2, '0')}`);
}

// Every hour maps to exactly one part, matching the spec table.
const expectedByHour = (h) => (h >= 5 && h <= 10 ? 'pagi' : h >= 11 && h <= 14 ? 'siang' : h >= 15 && h <= 17 ? 'sore' : 'malam');
for (let h = 0; h < 24; h += 1) assert.equal(dayPartForHour(h), expectedByHour(h), `hour ${h}`);
assert.equal(dayPartForHour(24), 'malam');
assert.equal(dayPartForHour(-1), 'malam');

// Challenge success uses the occurrence trigger time, not "now".
const rang = at(6, 30).getTime();
const solvedLate = at(11, 5);
assert.equal(greetingForOccurrence(rang, solvedLate), 'Selamat pagi!', 'uses trigger time');
assert.equal(greetingForOccurrence(at(17, 59).getTime(), at(18, 1)), 'Selamat sore!', 'boundary crossed while solving');
assert.equal(greetingForOccurrence(Number.NaN, solvedLate), 'Selamat siang!', 'invalid trigger falls back');
assert.equal(greetingForOccurrence(0, at(5, 0)), 'Selamat pagi!', 'zero trigger falls back');

console.log('Hasil: assertion sapaan waktu lulus.');
