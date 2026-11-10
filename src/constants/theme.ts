/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#392A25',
    background: '#F6EFE9',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#F1E2D9',
    textSecondary: '#947F74',
  },
  dark: {
    text: '#F7EDE7',
    background: '#241D1A',
    backgroundElement: '#332925',
    backgroundSelected: '#4B372F',
    textSecondary: '#C3A99B',
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
  primary: '#D45B32',
  primaryDark: '#A94120',
  secondary: '#927B70',
  tertiary: '#B5A39A',
  cream: '#F6EFE9',
  peach: '#FBEDE6',
  white: '#FFFFFF',
  darkBrown: '#392A25',
  border: '#EADBD2',
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
