/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  // Contrast-checked (WCAG AA 4.5:1) against background and backgroundElement.
  light: {
    text: '#171614',
    background: '#F6F4EB',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#ECE8DE',
    textSecondary: '#68645E',
    primary: '#FF6B1F',
    primaryStrong: '#A83D08',
    primarySoft: '#FFE5D5',
    onPrimary: '#171614',
    border: '#DED9CF',
    danger: '#B3261E',
    dangerSoft: '#FBE4E0',
    success: '#276A43',
    successSoft: '#E3F1E7',
  },
  dark: {
    text: '#F6F4EB',
    background: '#121212',
    backgroundElement: '#1E1E1E',
    backgroundSelected: '#2A2A2A',
    textSecondary: '#BDB8B0',
    primary: '#FF7A35',
    primaryStrong: '#FF9A61',
    primarySoft: '#3B261B',
    onPrimary: '#171614',
    border: '#3A3936',
    danger: '#F28B82',
    dangerSoft: '#4A2622',
    success: '#8EC99D',
    successSoft: '#1F3A2A',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;

/**
 * Single brand accent for the whole app (taste: color consistency lock).
 * Neutral surfaces come from Colors; this is the only saturated color.
 */
export const AlarmPalette = {
  primary: '#FF6B1F',
  primaryDark: '#A83D08',
  secondary: '#68645E',
  tertiary: '#8F8F8F',
  cream: '#F6F4EB',
  peach: '#FFE5D5',
  white: '#FFFFFF',
  darkBrown: '#121212',
  border: '#DED9CF',
} as const;

export const Accent = AlarmPalette.primary;
export const Danger = '#B74B39' as const;

/**
 * Single corner-radius system (taste: shape consistency lock).
 * blocks = section surfaces, controls = buttons/inputs, chip = pills.
 */
export const Radius = {
  block: 16,
  control: 12,
  chip: 999,
} as const;
