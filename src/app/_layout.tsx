import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider, useAuth } from '@/contexts/auth-context';

SplashScreen.preventAutoHideAsync();

// ---------------------------------------------------------------------------
// Root layout — wraps the whole app in AuthProvider and ThemeProvider.
// The navigator lives in a child component so it can read the auth context.
// ---------------------------------------------------------------------------

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <AuthProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        <RootNavigator />
      </ThemeProvider>
    </AuthProvider>
  );
}

// ---------------------------------------------------------------------------
// RootNavigator reads the session and applies Stack.Protected guards.
// While isLoading is true the splash overlay is still covering the screen,
// so we render nothing to avoid a flash of unauthenticated content.
// ---------------------------------------------------------------------------

function RootNavigator() {
  const { session, isLoading } = useAuth();

  if (isLoading) {
    // Return null while the splash overlay is on screen; avoids a white flash.
    return null;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* Authenticated group — only accessible when a session exists */}
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>

      {/* Auth group — only accessible when there is no session */}
      <Stack.Protected guard={!session}>
        <Stack.Screen name="auth" />
      </Stack.Protected>
    </Stack>
  );
}
