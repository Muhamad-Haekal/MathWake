import AppTabs from '@/components/app-tabs';

// ---------------------------------------------------------------------------
// App layout — only rendered when the user has an active session.
// AppTabs uses NativeTabs from expo-router/unstable-native-tabs and declares
// the 'index', 'alarms', and 'explore' tab triggers.  The actual screen files
// (index.tsx, alarms.tsx, explore.tsx) are siblings of this layout inside (app)/.
// ---------------------------------------------------------------------------

export default function AppLayout() {
  return <AppTabs />;
}
