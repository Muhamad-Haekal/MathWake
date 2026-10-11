import { useCallback, useRef } from 'react';
import { Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NextAlarmCard } from '@/components/home/next-alarm-card';
import { RoutineSummary } from '@/components/home/routine-summary';
import { TodayStats } from '@/components/home/today-stats';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Danger, MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/auth-context';
import { useHomeData } from '@/hooks/use-home-data';
import { useTheme } from '@/hooks/use-theme';
import { formatFullDateID, greetingForHour } from '@/lib/home-data';
import { useFocusEffect } from 'expo-router';

// ---------------------------------------------------------------------------
// Home dashboard. All sections render real Supabase data (alarms,
// routine_items + routine_completions, alarm_logs, attempts) with
// skeleton loading, truthful empty states, and an inline error + retry.
// ---------------------------------------------------------------------------

export default function HomeScreen() {
  const { signOut, user } = useAuth();
  const { data, isLoading, isRefreshing, error, refresh } = useHomeData();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const now = new Date();
  const greeting = greetingForHour(now.getHours());
  const todayLabel = formatFullDateID(now);

  // Refresh when returning from the Alarm tab so edits show immediately.
  // The first focus is skipped because the initial load already ran.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      refresh();
    }, [refresh]),
  );

  function handleSignOut() {
    if (Platform.OS === 'web') {
      signOut();
      return;
    }
    Alert.alert('Keluar', 'Yakin ingin keluar dari akun?', [
      { text: 'Batal', style: 'cancel' },
      { text: 'Keluar', style: 'destructive', onPress: signOut },
    ]);
  }

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
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={refresh} />
        }
        showsVerticalScrollIndicator={false}>
        <View style={styles.inner}>
          {/* Greeting + account */}
          <View style={styles.headerRow}>
            <View style={styles.headerText}>
              <ThemedText style={styles.greeting}>{greeting}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {todayLabel}
              </ThemedText>
              {user?.email ? (
                <ThemedText type="small" themeColor="textSecondary">
                  {user.email}
                </ThemedText>
              ) : null}
            </View>
            <Pressable
              onPress={handleSignOut}
              accessibilityRole="button"
              accessibilityLabel="Keluar dari akun"
              hitSlop={12}>
              <ThemedText type="small" style={styles.signOutText}>
                Keluar
              </ThemedText>
            </Pressable>
          </View>

          {isLoading ? (
            <HomeSkeleton />
          ) : error || !data ? (
            <View style={[styles.errorCard, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="smallBold">Gagal memuat data</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.errorBody}>
                {error ?? 'Terjadi kesalahan. Coba lagi nanti.'}
              </ThemedText>
              <Pressable
                style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
                onPress={refresh}
                accessibilityRole="button"
                accessibilityLabel="Coba muat ulang">
                <ThemedText type="small" style={styles.retryText}>
                  Coba lagi
                </ThemedText>
              </Pressable>
            </View>
          ) : (
            <View style={styles.sections}>
              <NextAlarmCard
                nextAlarm={data.nextAlarm}
                activeCount={data.activeAlarms.length}
                now={now}
              />
              <RoutineSummary
                routine={data.routine}
                done={data.routineDone}
                total={data.routineTotal}
              />
              <TodayStats
                alarmsRang={data.logsToday}
                attemptsTotal={data.attemptsToday.total}
                attemptsCorrect={data.attemptsToday.correct}
                routinesDone={data.routineDone}
                attemptsUnavailable={data.attemptsUnavailable}
              />
            </View>
          )}
        </View>
      </ScrollView>
    </ThemedView>
  );
}

/** Skeleton blocks echoing the dashboard shape (no generic spinner). */
function HomeSkeleton() {
  const theme = useTheme();
  const block = { backgroundColor: theme.backgroundElement };
  return (
    <View style={styles.sections} accessibilityLabel="Memuat data">
      <View style={[styles.skeletonHero, block]} />
      <View style={[styles.skeletonLine, block]} />
      <View style={[styles.skeletonLine, block]} />
      <View style={[styles.skeletonLine, block]} />
      <View style={styles.skeletonRow}>
        <View style={[styles.skeletonCell, block]} />
        <View style={[styles.skeletonCell, block]} />
        <View style={[styles.skeletonCell, block]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
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
  headerText: {
    flex: 1,
    gap: Spacing.half,
  },
  greeting: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  signOutText: {
    color: Danger,
    fontWeight: '700',
    paddingTop: Spacing.one,
  },
  sections: {
    gap: Spacing.five,
  },
  errorCard: {
    borderRadius: Radius.block,
    padding: Spacing.four,
    gap: Spacing.two,
  },
  errorBody: {
    lineHeight: 20,
  },
  retryButton: {
    backgroundColor: Danger,
    borderRadius: Radius.control,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.one,
  },
  retryText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.8,
  },
  skeletonHero: {
    height: 168,
    borderRadius: Radius.block,
  },
  skeletonLine: {
    height: 44,
    borderRadius: Radius.control,
  },
  skeletonRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  skeletonCell: {
    flex: 1,
    height: 84,
    borderRadius: Radius.control,
  },
});
