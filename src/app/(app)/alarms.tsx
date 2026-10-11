import { useEffect, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AlarmEditorModal } from '@/components/alarms/alarm-editor-modal';
import { SectionHeader } from '@/components/home/section-header';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Accent, BottomTabInset, Danger, MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useAlarms } from '@/hooks/use-alarms';
import { useTheme } from '@/hooks/use-theme';
import { setAlarmActive, type AlarmForm } from '@/lib/alarms';
import { describeAlarmSchedule, formatTimeID, isOnceExpired, type AlarmRow } from '@/lib/home-data';
import { initOnceAlarmDeactivation } from '@/lib/scheduling';
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
    busyId,
    refresh,
    saveAlarm,
    toggleAlarm,
    removeAlarm,
    requestPermission,
  } = useAlarms();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [editorVisible, setEditorVisible] = useState(false);
  const [editing, setEditing] = useState<AlarmRow | null>(null);
  const [saving, setSaving] = useState(false);

  // One-time alarms deactivate after their notification is tapped (dev-build
  // path only; no-op on web and in Expo Go). Registered once per mount.
  useEffect(() => {
    initOnceAlarmDeactivation({
      getUserId: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
      deactivateAlarm: (userId, alarmId) => setAlarmActive(supabase, userId, alarmId, false),
      isOneTimeAlarm: async (userId, alarmId) => {
        const { data } = await supabase
          .from('alarms')
          .select('is_recurring')
          .eq('id', alarmId)
          .eq('user_id', userId)
          .single();
        return (data as { is_recurring?: unknown } | null)?.is_recurring === false;
      },
    }).then(() => {
      refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    setEditing(null);
    setEditorVisible(true);
  }

  function openEdit(alarm: AlarmRow) {
    setEditing(alarm);
    setEditorVisible(true);
  }

  async function handleSave(form: AlarmForm): Promise<boolean> {
    setSaving(true);
    try {
      return await saveAlarm(form, editing?.id);
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
          setEditorVisible(false);
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
              style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
              <ThemedText type="small" style={styles.addText}>+ Tambah</ThemedText>
            </Pressable>
          </View>

          {permission === 'denied' ? (
            <View style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" style={styles.noticeText}>
                Izin notifikasi ditolak, jadi alarm tidak akan berbunyi. Nyalakan izinnya di
                pengaturan perangkat.
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

          {scheduleNote && (permission === 'granted' || permission === 'unsupported') ? (
            <ThemedText type="small" themeColor="textSecondary">{scheduleNote}</ThemedText>
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
                accessibilityLabel="Coba muat ulang">
                <ThemedText type="small" style={styles.retryText}>Coba lagi</ThemedText>
              </Pressable>
            </View>
          ) : alarms.length === 0 ? (
            <View style={styles.empty}>
              <ThemedText type="smallBold" style={styles.emptyTitle}>Belum ada alarm</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.emptyBody}>
                Tambah alarm pertamamu supaya MathWake membangunkanmu tepat waktu.
              </ThemedText>
            </View>
          ) : (
            <View>
              <SectionHeader title="Semua alarm" />
              <View>
                {alarms.map((alarm, index) => (
                  <AlarmRowView
                    key={alarm.id}
                    alarm={alarm}
                    showDivider={index > 0}
                    busy={busyId === alarm.id}
                    onOpen={() => openEdit(alarm)}
                    onToggle={(active) => toggleAlarm(alarm, active)}
                  />
                ))}
              </View>
            </View>
          )}
        </View>
      </ScrollView>

      <AlarmEditorModal
        visible={editorVisible}
        alarm={editing}
        saving={saving}
        onClose={() => setEditorVisible(false)}
        onSave={handleSave}
        onDelete={handleDeleteRequest}
      />
    </ThemedView>
  );
}

function AlarmRowView({
  alarm,
  showDivider,
  busy,
  onOpen,
  onToggle,
}: {
  alarm: AlarmRow;
  showDivider: boolean;
  busy: boolean;
  onOpen: () => void;
  onToggle: (active: boolean) => void;
}) {
  const theme = useTheme();
  // Expired one-time alarm: its moment passed, so it will never ring again
  // until edited with a new future time. Shown distinctly from user-off.
  const expiredOnce = alarm.is_recurring === false && isOnceExpired(alarm.time, new Date());
  const meta = [expiredOnce ? 'Kedaluwarsa' : describeAlarmSchedule(alarm)];
  if (alarm.difficulty) meta.push(`Level ${alarm.difficulty}`);
  if (typeof alarm.question_count === 'number') meta.push(`${alarm.question_count} soal`);

  return (
    <View
      style={[
        styles.row,
        showDivider && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.backgroundSelected,
        },
      ]}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Ubah alarm ${formatTimeID(alarm.time)}`}
        style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}>
        <ThemedText style={[styles.rowTime, !alarm.is_active && { color: theme.textSecondary }]}>
          {formatTimeID(alarm.time)}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {meta.join('   ')}
        </ThemedText>
      </Pressable>
      <Switch
        value={alarm.is_active}
        disabled={busy}
        onValueChange={onToggle}
        trackColor={{ false: theme.backgroundSelected, true: Accent }}
        accessibilityLabel={alarm.is_active ? 'Matikan alarm' : 'Nyalakan alarm'}
      />
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
    backgroundColor: Accent,
    borderRadius: Radius.chip,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two + Spacing.half,
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
  },
  rowMain: { flex: 1, gap: Spacing.half },
  rowTime: {
    fontSize: 32,
    lineHeight: 36,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  errorCard: {
    borderRadius: Radius.block,
    padding: Spacing.four,
    gap: Spacing.two,
  },
  errorBody: { lineHeight: 20 },
  retryButton: {
    backgroundColor: Danger,
    borderRadius: Radius.control,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.one,
  },
  retryText: { color: '#ffffff', fontWeight: '700' },
  empty: { gap: Spacing.one, paddingVertical: Spacing.four },
  emptyTitle: { fontSize: 17, lineHeight: 24 },
  emptyBody: { lineHeight: 20 },
  skeletonWrap: { gap: Spacing.two },
  skeletonLine: { height: 76, borderRadius: Radius.control },
  pressed: { opacity: 0.8 },
});
