import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { useState } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, Keyframe, useReducedMotion } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const INITIAL_SCALE_FACTOR = Dimensions.get('screen').height / 90;
const DURATION = 600;

const splashExitKeyframe = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }] },
  72: { opacity: 1 },
  100: {
    opacity: 0,
    transform: [{ translateY: -5 }],
    easing: Easing.out(Easing.cubic),
  },
});

const markRevealKeyframe = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 10 }, { scale: 0.96 }] },
  100: {
    opacity: 1,
    transform: [{ translateY: 0 }, { scale: 1 }],
    easing: Easing.out(Easing.cubic),
  },
});

const copyRevealKeyframe = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 5 }] },
  35: { opacity: 0, transform: [{ translateY: 5 }] },
  100: {
    opacity: 1,
    transform: [{ translateY: 0 }],
    easing: Easing.out(Easing.cubic),
  },
});

export function AnimatedSplashOverlay() {
  const reduceMotion = useReducedMotion();
  const [animate, setAnimate] = useState(false);
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  const brandLockup = (
    <View style={styles.splashLockup}>
      <Animated.View entering={markRevealKeyframe.duration(300)}>
        <Image style={styles.splashMark} source={require('@/assets/images/mathwake-mark.png')} />
      </Animated.View>
      <Animated.View entering={copyRevealKeyframe.duration(340)} style={styles.splashCopy}>
        <Text style={styles.splashWordmark}>MathWake</Text>
        <Text style={styles.splashTagline}>Wake up. Solve. Grow.</Text>
      </Animated.View>
    </View>
  );

  return animate ? (
    <Animated.View
      entering={splashExitKeyframe.duration(DURATION).withCallback((finished) => {
        'worklet';
        if (finished) {
          scheduleOnRN(setVisible, false);
        }
      })}
      style={styles.splashOverlay}>
      {brandLockup}
    </Animated.View>
  ) : (
    <View
      onLayout={() => {
        SplashScreen.hideAsync().finally(() => {
          if (reduceMotion) setVisible(false);
          else setAnimate(true);
        });
      }}
      style={styles.splashOverlay}>
      {brandLockup}
    </View>
  );
}

const keyframe = new Keyframe({
  0: {
    transform: [{ scale: INITIAL_SCALE_FACTOR }],
  },
  100: {
    transform: [{ scale: 1 }],
    easing: Easing.elastic(0.7),
  },
});

const logoKeyframe = new Keyframe({
  0: {
    transform: [{ scale: 1.3 }],
    opacity: 0,
  },
  40: {
    transform: [{ scale: 1.3 }],
    opacity: 0,
    easing: Easing.elastic(0.7),
  },
  100: {
    opacity: 1,
    transform: [{ scale: 1 }],
    easing: Easing.elastic(0.7),
  },
});

const glowKeyframe = new Keyframe({
  0: {
    transform: [{ rotateZ: '0deg' }],
  },
  100: {
    transform: [{ rotateZ: '7200deg' }],
  },
});

export function AnimatedIcon() {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return (
      <View style={styles.iconContainer}>
        <Image style={styles.glow} source={require('@/assets/images/logo-glow.png')} />
        <View style={styles.background} />
        <View style={styles.imageContainer}>
          <Image style={styles.image} source={require('@/assets/images/mathwake-mark.png')} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.iconContainer}>
      <Animated.View entering={glowKeyframe.duration(60 * 1000 * 4)} style={styles.glow}>
        <Image style={styles.glow} source={require('@/assets/images/logo-glow.png')} />
      </Animated.View>

      <Animated.View entering={keyframe.duration(DURATION)} style={styles.background} />
      <Animated.View style={styles.imageContainer} entering={logoKeyframe.duration(DURATION)}>
        <Image style={styles.image} source={require('@/assets/images/mathwake-mark.png')} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  imageContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  glow: {
    width: 201,
    height: 201,
    position: 'absolute',
  },
  iconContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 128,
    height: 128,
    zIndex: 100,
  },
  image: {
    width: 92,
    height: 92,
  },
  background: {
    borderRadius: 40,
    experimental_backgroundImage: `linear-gradient(180deg, #252320, #121212)`,
    width: 128,
    height: 128,
    position: 'absolute',
  },
  splashOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#121212',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  splashLockup: {
    alignItems: 'center',
    gap: 12,
  },
  splashMark: {
    width: 124,
    height: 124,
  },
  splashCopy: {
    alignItems: 'center',
    gap: 4,
  },
  splashWordmark: {
    color: '#F6F4EB',
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  splashTagline: {
    color: '#BDB8B0',
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.8,
  },
});
