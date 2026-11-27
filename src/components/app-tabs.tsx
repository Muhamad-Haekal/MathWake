import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';

export default function AppTabs() {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'unspecified' ? 'light' : scheme];

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.primarySoft}
      iconColor={{ default: colors.textSecondary, selected: colors.primaryStrong }}
      labelStyle={{
        default: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
        selected: { color: colors.primaryStrong, fontSize: 11, fontWeight: '700' },
      }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'house', selected: 'house.fill' }}
          md={{ default: 'home', selected: 'home_filled' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="alarms">
        <NativeTabs.Trigger.Label>Alarm</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'alarm', selected: 'alarm.fill' }}
          md={{ default: 'alarm', selected: 'alarm_on' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="timer">
        <NativeTabs.Trigger.Label>Timer</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'timer', selected: 'timer' }}
          md={{ default: 'timer', selected: 'timer' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="stopwatch">
        <NativeTabs.Trigger.Label>Stopwatch</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'stopwatch', selected: 'stopwatch.fill' }}
          md={{ default: 'speed', selected: 'speed' }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
