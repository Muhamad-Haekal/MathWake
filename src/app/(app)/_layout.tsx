import AppTabs from '@/components/app-tabs';

// ---------------------------------------------------------------------------
// App layout — only rendered when the user has an active session.
// AppTabs declares the app's Home, Alarm, Timer, and Stopwatch tab triggers.
// ---------------------------------------------------------------------------

export default function AppLayout() {
  return <AppTabs />;
}
