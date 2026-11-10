import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';

/**
 * Web hydration-safe color scheme hook using useSyncExternalStore.
 *
 * Three responsibilities:
 *  1. SSR safety: getServerSnapshot always returns 'light' so static/SSR
 *     output is deterministic and never mismatches on hydration.
 *  2. Live updates: subscribe registers an Appearance change listener so
 *     React re-renders when the OS color scheme changes at runtime.
 *  3. Snapshot: getSnapshot reads the current value synchronously from
 *     Appearance.getColorScheme() — the same source useColorScheme uses
 *     internally in React Native.
 *
 * The previous implementation used a no-op subscribe which meant React
 * would never be notified of OS theme changes after the initial render.
 */
export function useColorScheme() {
  return useSyncExternalStore(
    // subscribe: called by React to register a listener.
    // Must return an unsubscribe function. Appearance.addChangeListener
    // returns a subscription object with a remove() method.
    (callback) => {
      const sub = Appearance.addChangeListener(callback);
      return () => sub.remove();
    },
    // getSnapshot (client): read the current scheme synchronously.
    // Falls back to 'light' if the platform returns null (uncommon).
    () => Appearance.getColorScheme() ?? 'light',
    // getServerSnapshot: stable value for SSR / static generation.
    // Always 'light' to avoid hydration mismatches.
    () => 'light' as const,
  );
}
