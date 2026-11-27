import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');

const timer = read('src/app/(app)/timer.tsx');
const stopwatch = read('src/app/(app)/stopwatch.tsx');
const profile = read('src/app/profile.tsx');
const register = read('src/app/auth/register.tsx');
const onboarding = read('src/app/onboarding.tsx');
const root = read('src/app/_layout.tsx');
const challenge = read('src/app/challenge.tsx');
const editor = read('src/components/alarms/alarm-editor-modal.tsx');
const nextAlarm = read('src/components/home/next-alarm-card.tsx');
const collapsible = read('src/components/ui/collapsible.tsx');
const ripple = read('src/components/ui/android-ripple.ts');

assert.match(timer, /KeyboardAvoidingView[\s\S]*keyboardShouldPersistTaps="handled"/);
assert.match(timer, /flexWrap: 'wrap'/);
assert.match(timer, /minHeight: 48/);
assert.match(timer, /numberOfLines=\{1\} adjustsFontSizeToFit/);
assert.match(stopwatch, /flexWrap: 'wrap'/);
assert.match(stopwatch, /minHeight: 48/);
assert.match(stopwatch, /numberOfLines=\{1\} adjustsFontSizeToFit/);

const accountBlock = profile.match(/<View style=\{styles\.accountInfo\}>([\s\S]*?)<\/View>/)?.[1] ?? '';
assert.match(profile, /KeyboardAvoidingView[\s\S]*keyboardShouldPersistTaps="handled"/);
assert.match(accountBlock, /styles\.accountName/);
assert.match(accountBlock, /styles\.accountEmail/);
assert.doesNotMatch(accountBlock, /numberOfLines/);
assert.match(register, /<ScrollView[\s\S]*s\.confirmCard[\s\S]*<\/ScrollView>/);
assert.match(onboarding, /<ScrollView style=\{styles\.flex\} contentContainerStyle=\{styles\.content\}/);

assert.match(root, /animation: reduceMotion \? 'none' : 'fade'/);
assert.match(root, /animation: reduceMotion \? 'none' : 'slide_from_bottom'/);
assert.match(challenge, /useReducedMotion/);
assert.match(editor, /useReducedMotion/);
assert.match(nextAlarm, /useReducedMotion/);
assert.match(collapsible, /useReducedMotion/);
assert.match(ripple, /Platform\.OS === 'android'[\s\S]*foreground: true/);

console.log('Hasil: responsive layout, target sentuh, ripple Android, dan reduced-motion assertions lulus.');
