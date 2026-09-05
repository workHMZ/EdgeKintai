import type { PublicAppConfig, TransportMode, TransportTripType, User } from '../types';

function integerSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function tripTypeSetting(value: string | undefined): TransportTripType {
  return value === 'one_way' ? 'one_way' : 'round_trip';
}

function timeSetting(value: string | undefined): string | null {
  if (!value || !/^[0-2]\d:[0-5]\d$/.test(value)) return null;
  if (Number.parseInt(value.slice(0, 2), 10) > 23) return null;
  return value;
}

export function getPublicConfig(env: CloudflareBindings): PublicAppConfig {
  return {
    timezone: 'Asia/Tokyo',
    default_break_minutes: integerSetting(env.DEFAULT_BREAK_MINUTES, 60, 0, 480),
    default_one_way_fare: integerSetting(env.DEFAULT_ONE_WAY_FARE, 210, 0, 100_000),
    default_trip_type: tripTypeSetting(env.DEFAULT_TRIP_TYPE),
    default_clock_in: timeSetting(env.DEFAULT_CLOCK_IN),
    default_clock_out: timeSetting(env.DEFAULT_CLOCK_OUT),
    overtime_threshold_hours: integerSetting(env.OVERTIME_THRESHOLD_HOURS, 180, 0, 744),
  };
}

export function getSessionTtlSeconds(env: CloudflareBindings): number {
  return integerSetting(env.SESSION_TTL_SECONDS, 604_800, 300, 2_592_000);
}

export function getUserCommuteDefaults(
  env: CloudflareBindings,
  user: Pick<
    User,
    | 'default_one_way_fare'
    | 'default_trip_type'
    | 'default_transport_mode'
    | 'default_transport_origin'
    | 'default_transport_destination'
  >,
  cachedConfig?: PublicAppConfig,
): {
  one_way_fare: number;
  trip_type: TransportTripType;
  transport_mode: TransportMode;
  transport_origin: string;
  transport_destination: string;
} {
  const config = cachedConfig ?? getPublicConfig(env);
  return {
    one_way_fare: user.default_one_way_fare ?? config.default_one_way_fare,
    trip_type: user.default_trip_type || config.default_trip_type,
    transport_mode: user.default_transport_mode || 'rail',
    transport_origin: user.default_transport_origin || '',
    transport_destination: user.default_transport_destination || '',
  };
}

export function getUserAttendanceDefaults(
  env: CloudflareBindings,
  user: Pick<
    User,
    'default_clock_in' | 'default_clock_out' | 'default_break_minutes' | 'default_work_type'
  >,
): {
  clock_in: string | null;
  clock_out: string | null;
  break_minutes: number;
  work_type: 'office' | 'remote';
} {
  const config = getPublicConfig(env);
  return {
    clock_in: user.default_clock_in ?? config.default_clock_in,
    clock_out: user.default_clock_out ?? config.default_clock_out,
    break_minutes: user.default_break_minutes,
    work_type: user.default_work_type,
  };
}
