import { Platform, type ColorValue, type PressableProps } from 'react-native';

/** Native Android ripple while keeping iOS and web feedback in their own styles. */
export function androidRipple(color: ColorValue): PressableProps['android_ripple'] {
  return Platform.OS === 'android' ? { color, foreground: true } : undefined;
}
