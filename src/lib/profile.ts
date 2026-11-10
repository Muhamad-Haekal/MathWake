import type { User } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

export type Profile = {
  id: string;
  role: string;
  created_at: string;
  display_name: string | null;
  onboarding_completed: boolean;
};

type ProfileResult = {
  data: Profile | null;
  error: Error | null;
};

const PROFILE_COLUMNS = 'id,role,created_at,display_name,onboarding_completed';
export const PROFILE_DISPLAY_NAME_MAX_LENGTH = 80;

export function validateProfileDisplayName(displayName: string): string | null {
  const normalized = displayName.trim();
  if (!normalized || normalized.length > PROFILE_DISPLAY_NAME_MAX_LENGTH) {
    return 'Nama harus berisi 1 sampai 80 karakter.';
  }
  return null;
}

export function isGoogleUser(user: User | null): boolean {
  const provider = user?.app_metadata?.provider;
  const providers = user?.app_metadata?.providers;
  const identities = user?.identities;
  return provider === 'google'
    || (Array.isArray(providers) && providers.includes('google'))
    || (Array.isArray(identities) && identities.some((identity) => identity.provider === 'google'));
}

function asProfile(value: unknown): Profile | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== 'object') return null;
  const profile = candidate as Partial<Profile>;
  if (
    typeof profile.id !== 'string'
    || typeof profile.role !== 'string'
    || typeof profile.created_at !== 'string'
    || (typeof profile.display_name !== 'string' && profile.display_name !== null)
    || typeof profile.onboarding_completed !== 'boolean'
  ) return null;
  return profile as Profile;
}

export async function fetchMyProfile(userId: string): Promise<ProfileResult> {
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', userId)
    .maybeSingle();

  if (error) return { data: null, error: new Error('profile query failed') };
  const profile = asProfile(data);
  if (profile) return { data: profile, error: null };

  const repair = await supabase.rpc('ensure_my_profile');
  if (repair.error) return { data: null, error: new Error('profile repair failed') };

  const repaired = asProfile(repair.data);
  if (!repaired || repaired.id !== userId) {
    return { data: null, error: new Error('profile repair returned invalid data') };
  }
  return { data: repaired, error: null };
}

export async function completeMyOnboarding(displayName: string): Promise<ProfileResult> {
  const { data, error } = await supabase.rpc('complete_my_onboarding', {
    p_display_name: displayName.trim(),
  });
  if (error) return { data: null, error: new Error('onboarding completion failed') };

  const profile = asProfile(data);
  if (!profile) return { data: null, error: new Error('onboarding returned invalid data') };
  return { data: profile, error: null };
}
