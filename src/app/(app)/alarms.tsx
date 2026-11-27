import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Alert,
    AppState,
    Linking,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Switch,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { router, useFocusEffect } from 'expo-router';

import { AlarmEditorModal } from '@/components/alarms/alarm-editor-modal';
import { SectionHeader } from '@/components/home/section-header';
import { androidRipple } from '@/components/ui/android-ripple';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Accent, BottomTabInset, Danger, MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useAlarms } from '@/hooks/use-alarms';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/contexts/auth-context';
import {
  clearAlarmEditorDraft,
  loadAlarmEditorDraft,
  saveAlarmEditorDraft,
  type AlarmEditorDraft,
} from '@/lib/alarm-editor-draft';
import { canEnableAlarm, type AlarmForm } from '@/lib/alarms';
import type { AlarmRingtone } from '@/lib/alarm-ringtones';
import { describeAlarmSchedule, formatTimeID, isOnceExpired, type AlarmRow } from '@/lib/home-data';
import { initChallengeNotificationHandler } from '@/lib/scheduling';
import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Alarm tab: user-owned alarm list with toggle, create/edit sheet, delete,
// and local notification scheduling status. Indonesian copy throughout.
// ---------------------------------------------------------------------------

export default function AlarmsScreen() {
  const {
    alarms,
    isLoading,
    isRefreshing,
    error,
    permission,
    scheduleNote,
    needsExactAlarmSettings,
    needsFullScreenSettings,
    busyId,
    refresh,
    saveAlarm,
    toggleAlarm,
    removeAlarm,
    requestPermission,
    openExactAlarmSettings,
    openAppInfoSettings,
  } = useAlarms();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const userId = user?.id;

  const [editorVisible, setEditorVisible] = useState(false);
  const [editing, setEditing] = useState<AlarmRow | null>(null);
  const [restoredDraft, setRestoredDraft] = useState<AlarmEditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const restoredDraftUserId = useRef<string | null>(null);

  useEffect(() => {
    const userId = user?.id;
    if (!userId || isLoading || restoredDraftUserId.current === userId) return;
    let active = true;
    void loadAlarmEditorDraft(userId).then((draft) => {
      if (!active) return;
      restoredDraftUserId.current = userId;
      if (!draft) return;
      const alarm = draft.alarmId ? alarms.find((item) => item.id === draft.alarmId) : null;
      if (draft.alarmId && !alarm) {
        void clearAlarmEditorDraft(userId);
        return;
      }
      setRestoredDraft(draft);
      setEditing(alarm ?? null);
      setEditorVisible(true);
      console.info('[MathWakeDiag]', {
        stage: 'editor.draft.restored',
        timestampMs: Date.now(),
        kind: draft.alarmId ? 'existing' : 'new',
        hasCustomRingtone: draft.ringtone.kind === 'custom',
      });
    });
    return () => { active = false; };
  }, [alarms, isLoading, user?.id]);

  // Open challenge when the user taps an alarm notification.
  //    fetchAlarmConfig validates ownership via .eq('user_id', userId).
  // NOTE: a one-time alarm is no longer deactivated on notification tap —
  //    it is deactivated only on a valid challenge success (challenge.tsx)
  //    or when its occurrence is reported as expired by reschedule (use-alarms).
  useEffect(() => {
    const getUserId = async () =>
      (await supabase.auth.getUser()).data.user?.id ?? null;

    initChallengeNotificationHandler({
      getUserId,
      fetchAlarmConfig: async (userId, alarmId) => {
        const { data } = await supabase
          .from('alarms')
          .select('difficulty,question_count,title')
          .eq('id', alarmId)
          .eq('user_id', userId)
          .single();
        if (!data) return null;
        const row = data as { difficulty?: unknown; question_count?: unknown; title?: unknown };
        return {
          difficulty:
            typeof row.difficulty === 'string' ? row.difficulty : 'sedang',
          question_count:
            typeof row.question_count === 'number' && row.question_count >= 1
              ? row.question_count
              : 3,
          title: typeof row.title === 'string' ? row.title.trim().slice(0, 40) || 'Alarm' : 'Alarm',
        };
      },
      navigateToReminder: (params) => {
        router.push({ pathname: '/alarm-reminder', params });
      },
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  function openCreate() {
    setRestoredDraft(null);
    setEditing(null);
    setEditorVisible(true);
  }

  function openEdit(alarm: AlarmRow) {
    setRestoredDraft(null);
    setEditing(alarm);
    setEditorVisible(true);
  }

  const persistEditorDraft = useCallback((draft: AlarmEditorDraft) => {
    if (!userId) return;
    void saveAlarmEditorDraft(userId, draft).catch(() => undefined);
  }, [userId]);

  function closeEditor() {
    setEditorVisible(false);
    setRestoredDraft(null);
    if (user?.id) void clearAlarmEditorDraft(user.id).catch(() => undefined);
  }

  async function handleSave(form: AlarmForm, ringtone: AlarmRingtone): Promise<AlarmRow | null> {
    setSaving(true);
    try {
      return await saveAlarm(form, editing?.id, ringtone);
    } finally {
      setSaving(false);
    }
  }

  function handleDeleteRequest(alarm: AlarmRow) {
    Alert.alert('Hapus alarm', `Hapus alarm pukul ${formatTimeID(alarm.time)}?`, [
      { text: 'Batal', style: 'cancel' },
      {
        text: 'Hapus',
        style: 'destructive',
        onPress: async () => {
          closeEditor();
          await removeAlarm(alarm.id);
        },
      },
    ]);
  }

  const activeCount = alarms.filter((a) => a.is_active).length;

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + Spacing.four,
            paddingBottom: insets.bottom + BottomTabInset + Spacing.four,
          },
        ]}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={refresh} />}
        showsVerticalScrollIndicator={false}>
        <View style={styles.inner}>
          <View style={styles.headerRow}>
            <View style={styles.headerText}>
              <ThemedText style={styles.title}>Alarm</ThemedText>
              {!isLoading && !error && alarms.length > 0 ? (
                <ThemedText type="small" themeColor="textSecondary">
                  {activeCount} dari {alarms.length} aktif
                </ThemedText>
              ) : null}
            </View>
            <Pressable
              onPress={openCreate}
              accessibilityRole="button"
              accessibilityLabel="Tambah alarm baru"
              android_ripple={androidRipple(theme.onPrimary)}
              style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
              <ThemedText type="small" style={[styles.addText, { color: theme.onPrimary }]}>＋ Tambah alarm</ThemedText>
            </Pressable>
          </View>

          {permission === 'denied' ? (
            <View style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" style={styles.noticeText}>
                Izin notifikasi ditolak, jadi notifikasi alarm tidak akan muncul. Alarm native
                tetap dicoba, tetapi nyalakan izin ini untuk melihat notifikasi dan membuka
                challenge dengan lebih andal.
              </ThemedText>
              <Pressable onPress={() => Linking.openSettings()} accessibilityRole="button">
                <ThemedText type="small" style={styles.linkText}>Buka pengaturan</ThemedText>
              </Pressable>
            </View>
          ) : permission === 'undetermined' ? (
            <View style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" style={styles.noticeText}>
                Izinkan notifikasi supaya alarm berbunyi tepat waktu.
              </ThemedText>
              <Pressable onPress={requestPermission} accessibilityRole="button">
                <ThemedText type="small" style={styles.linkText}>Izinkan notifikasi</ThemedText>
              </Pressable>
            </View>
          ) : permission === 'unavailable' ? (
            <View style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" style={styles.noticeText}>
                Notifikasi tidak tersedia di Expo Go, jadi alarm tidak akan berbunyi di sini.
                Alarm tetap tersimpan dan akan dijadwalkan di development build.
              </ThemedText>
            </View>
          ) : null}

          {needsExactAlarmSettings && permission === 'granted' ? (
            <View style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" style={styles.noticeText}>
                Sistem menolak alarm tepat waktu, jadi alarm bisa berbunyi tidak
                tepat waktu. Nyalakan izinnya supaya alarm membangunkanmu
                sesuai jadwal.
              </ThemedText>
              <Pressable onPress={() => openExactAlarmSettings()} accessibilityRole="button">
                <ThemedText type="small" style={styles.linkText}>Buka pengaturan alarm</ThemedText>
              </Pressable>
            </View>
          ) : null}

          {needsFullScreenSettings && permission === 'granted' ? (
            <View style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" style={styles.noticeText}>
                Alarm tidak bisa membuka challenge otomatis di atas layar kunci
                karena izinnya belum diberikan. Nyalakan izin tampil penuh
                supaya alarm membunyikan dan membuka challenge sendiri.
              </ThemedText>
              <Pressable onPress={() => openAppInfoSettings()} accessibilityRole="button">
                <ThemedText type="small" style={styles.linkText}>Buka info aplikasi</ThemedText>
              </Pressable>
            </View>
          ) : null}

          {scheduleNote && (permission === 'granted' || permission === 'unsupported') ? (
            <ThemedText type="small" themeColor="textSecondary">{scheduleNote}</ThemedText>
          ) : null}

          {error && alarms.length > 0 ? (
            <View style={[styles.notice, { backgroundColor: theme.backgroundElement, borderColor: theme.danger, borderWidth: 1 }]}>
              <ThemedText type="small" style={styles.noticeText}>{error}</ThemedText>
              <Pressable onPress={refresh} accessibilityRole="button" accessibilityLabel="Coba muat ulang">
                <ThemedText type="small" style={styles.linkText}>Coba lagi</ThemedText>
              </Pressable>
            </View>
          ) : null}

          {isLoading ? (
            <AlarmsSkeleton />
          ) : error && alarms.length === 0 ? (
            <View style={[styles.errorCard, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="smallBold">Gagal memuat alarm</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.errorBody}>
                {error}
              </ThemedText>
              <Pressable
                style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
                onPress={refresh}
                accessibilityRole="button"
                accessibilityLabel="Coba muat ulang"
                android_ripple={androidRipple(theme.onPrimary)}>
                <ThemedText type="small" style={styles.retryText}>Coba lagi</ThemedText>
              </Pressable>
            </View>
          ) : alarms.length === 0 ? (
            <View style={[styles.empty, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
              <ThemedText type="smallBold" style={styles.emptyTitle}>Belum ada alarm</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.emptyBody}>
                Tambah alarm pertamamu supaya MathWake membangunkanmu tepat waktu.
              </ThemedText>
              <Pressable onPress={openCreate} accessibilityRole="button" android_ripple={androidRipple(theme.onPrimary)} style={({ pressed }) => [styles.emptyButton, pressed && styles.pressed]}>
                <ThemedText type="small" style={[styles.addText, { color: theme.onPrimary }]}>Buat alarm pertama</ThemedText>
              </Pressable>
            </View>
          ) : (
            <View style={styles.alarmGroups}>
              {([true, false] as const).map((active) => {
                const group = alarms.filter((alarm) => alarm.is_active === active);
                if (group.length === 0) return null;
                return (
                  <View key={String(active)} style={styles.group}>
                    <View style={styles.groupHeading}>
                      <SectionHeader title={active ? 'Aktif' : 'Nonaktif'} />
                      <ThemedText type="small" themeColor="textSecondary" style={styles.groupCount}>
                        {group.length}
                      </ThemedText>
                    </View>
                    <View style={styles.alarmList}>
                      {group.map((alarm) => (
                        <AlarmRowView
                          key={alarm.id}
                          alarm={alarm}
                          busy={busyId === alarm.id}
                          onOpen={() => openEdit(alarm)}
                          onToggle={(nextActive) => {
                            if (nextActive && !canEnableAlarm(alarm)) {
                              openEdit(alarm);
                              return;
                            }
                            void toggleAlarm(alarm, nextActive);
                          }}
                        />
                      ))}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      <AlarmEditorModal
        visible={editorVisible}
        alarm={editing}
        draft={restoredDraft}
        saving={saving}
        onClose={closeEditor}
        onDraftChange={persistEditorDraft}
        onSave={handleSave}
        onDelete={handleDeleteRequest}
      />
    </ThemedView>
  );
}

function AlarmRowView({
  alarm,
  busy,
  onOpen,
  onToggle,
}: {
  alarm: AlarmRow;
  busy: boolean;
  onOpen: () => void;
  onToggle: (active: boolean) => void;
}) {
  const theme = useTheme();
  // Expired one-time alarm: its moment passed, so it will never ring again
  // until edited with a new future time. Shown distinctly from user-off.
  const expiredOnce = alarm.is_recurring === false && isOnceExpired(alarm.time, new Date());
  const canEnable = canEnableAlarm(alarm);
  // Block only turning ON: an alarm that is still on (e.g. mid-refresh) must
  // remain switchable off. The list cannot arm an expired occurrence.
  const enableBlocked = !alarm.is_active && !canEnable;
  const title = typeof alarm.title === 'string' ? alarm.title.trim() || 'Alarm' : 'Alarm';

  return (
    <View style={[styles.row, { backgroundColor: theme.backgroundElement, borderColor: theme.border }, !alarm.is_active && styles.inactiveRow]}>
      <View style={[styles.rowAccent, { backgroundColor: alarm.is_active ? theme.primary : theme.border }]} />
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${formatTimeID(alarm.time)}, ${title}, ${expiredOnce ? 'alarm terlewat' : alarm.is_active ? 'aktif' : 'nonaktif'}, ${describeAlarmSchedule(alarm)}, tantangan matematika ${alarm.difficulty ?? 'sedang'}, ${alarm.question_count ?? 3} soal`}
        accessibilityHint={enableBlocked ? 'Ubah jam alarm untuk menyalakan lagi' : undefined}
        android_ripple={androidRipple(theme.primarySoft)}
        style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}>
        <View style={styles.rowHeading}>
          <ThemedText style={[styles.rowTime, !alarm.is_active && { color: theme.textSecondary }]}>
            {formatTimeID(alarm.time)}
          </ThemedText>
          <View style={[styles.statusPill, { backgroundColor: alarm.is_active ? theme.successSoft : theme.background }]}>
            <ThemedText style={[styles.statusText, { color: alarm.is_active ? theme.success : theme.textSecondary }]}>{expiredOnce ? 'Lewat' : alarm.is_active ? 'Aktif' : 'Nonaktif'}</ThemedText>
          </View>
        </View>
        <ThemedText style={[styles.alarmTitle, { color: theme.text }]}>
          {title}
        </ThemedText>
        <ThemedText style={[styles.schedule, { color: theme.textSecondary }]}>
          {expiredOnce ? 'Sekali · sudah lewat — ubah jam untuk menyalakan lagi' : describeAlarmSchedule(alarm)}
        </ThemedText>
        <View style={[styles.challengeSummary, { backgroundColor: theme.background }]}>
          <ThemedText style={[styles.challengeLabel, { color: theme.textSecondary }]}>TANTANGAN</ThemedText>
          <ThemedText style={[styles.challengeValue, { color: theme.text }]}>
            {alarm.difficulty ?? 'Sedang'}
          </ThemedText>
          <View style={[styles.challengeDivider, { backgroundColor: theme.border }]} />
          <ThemedText style={[styles.challengeValue, { color: theme.text }]}>
            {alarm.question_count ?? 3} soal
          </ThemedText>
        </View>
      </Pressable>

      <View style={styles.rowActions}>
        <Switch
          value={alarm.is_active}
          disabled={busy || enableBlocked}
          onValueChange={onToggle}
          trackColor={{ false: theme.backgroundSelected, true: Accent }}
          thumbColor={alarm.is_active ? '#ffffff' : theme.backgroundElement}
          accessibilityLabel={
            enableBlocked
              ? 'Alarm sekali saja sudah lewat, ubah jam untuk menyalakan'
              : alarm.is_active
                ? 'Matikan alarm'
                : 'Nyalakan alarm'
          }
          accessibilityState={{ disabled: busy || enableBlocked, checked: alarm.is_active }}
          accessibilityRole="switch"
          hitSlop={8}
        />
      </View>
    </View>
  );
}

function AlarmsSkeleton() {
  const theme = useTheme();
  const block = { backgroundColor: theme.backgroundElement };
  return (
    <View style={styles.skeletonWrap} accessibilityLabel="Memuat alarm">
      <View style={[styles.skeletonLine, block]} />
      <View style={[styles.skeletonLine, block]} />
      <View style={[styles.skeletonLine, block]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  content: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  inner: {
    flex: 1,
    maxWidth: MaxContentWidth,
    gap: Spacing.four,
  },
  alarmGroups: { gap: Spacing.five },
  group: { gap: Spacing.two },
  groupHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  groupCount: { minWidth: 30, textAlign: 'right', fontVariant: ['tabular-nums'] },
  alarmList: { gap: Spacing.three },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  headerText: { flex: 1, gap: Spacing.half },
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  addButton: {
    minHeight: 48,
    backgroundColor: Accent,
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    marginTop: Spacing.one,
  },
  addText: { color: '#ffffff', fontWeight: '700' },
  notice: {
    borderRadius: Radius.block,
    padding: Spacing.four,
    gap: Spacing.two,
  },
  noticeText: { lineHeight: 20 },
  linkText: { color: Accent, fontWeight: '700' },
  row: {
    flexDirection: 'row', alignItems: 'stretch', gap: Spacing.three,
    padding: Spacing.three, borderWidth: 1, borderRadius: Radius.block + 2,
  },
  inactiveRow: { opacity: 0.82 },
  rowAccent: { width: 3, borderRadius: 2, marginVertical: 2 },
  rowMain: { flex: 1, minWidth: 0, gap: Spacing.one },
  rowHeading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, flexWrap: 'wrap' },
  statusPill: { minHeight: 24, justifyContent: 'center', borderRadius: Radius.chip, paddingHorizontal: Spacing.two },
  statusText: { fontSize: 11, fontWeight: '700' },
  alarmTitle: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  schedule: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  challengeSummary: { alignSelf: 'flex-start', minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: Spacing.two, borderRadius: Radius.control, paddingHorizontal: Spacing.two },
  challengeLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  challengeValue: { fontSize: 12, fontWeight: '700' },
  challengeDivider: { width: 1, height: 16 },
  rowActions: {
    minWidth: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  rowTime: {
    fontSize: 38,
    lineHeight: 44,
    fontWeight: '800',
    letterSpacing: -0.8,
    fontVariant: ['tabular-nums'],
  },
  errorCard: {
    borderRadius: Radius.block,
    padding: Spacing.four,
    gap: Spacing.two,
  },
  errorBody: { lineHeight: 20 },
  retryButton: {
    minHeight: 48,
    backgroundColor: Danger,
    borderRadius: Radius.control,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.one,
  },
  retryText: { color: '#ffffff', fontWeight: '700' },
  empty: { gap: Spacing.two, padding: Spacing.four, borderRadius: Radius.block, borderWidth: StyleSheet.hairlineWidth },
  emptyButton: { minHeight: 48, alignSelf: 'flex-start', backgroundColor: Accent, borderRadius: Radius.control, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, justifyContent: 'center' },
  emptyTitle: { fontSize: 17, lineHeight: 24 },
  emptyBody: { lineHeight: 20 },
  skeletonWrap: { gap: Spacing.two },
  skeletonLine: { height: 76, borderRadius: Radius.control },
  pressed: { opacity: 0.8 },
});
