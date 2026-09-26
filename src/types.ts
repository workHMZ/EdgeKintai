export type WorkType = 'office' | 'remote' | 'paid_leave' | 'holiday' | 'absent';
export type TransportTripType = 'one_way' | 'round_trip';
export type TransportMode = 'rail' | 'bus' | 'taxi' | 'other';

export interface User {
  id: number;
  username: string;
  display_name: string;
  is_admin: number;
  created_at: string;
  default_one_way_fare: number | null;
  default_trip_type: TransportTripType;
  default_transport_mode: TransportMode;
  default_transport_origin: string;
  default_transport_destination: string;
  default_clock_in: string | null;
  default_clock_out: string | null;
  default_break_minutes: number;
  default_work_type: 'office' | 'remote';
  auth_version: number;
}

export interface Attendance {
  id: number;
  revision: number;
  user_id: number;
  work_date: string;
  work_type: WorkType;
  clock_in: string | null;
  clock_out: string | null;
  break_minutes: number;
  transport_fee: number;
  transport_one_way_fee: number | null;
  transport_trip_type: TransportTripType;
  transport_mode: TransportMode;
  transport_origin: string;
  transport_destination: string;
  memo: string;
  created_at: string;
  updated_at: string;
}

export interface Holiday {
  date_str: string;
  name_ja: string;
}

export type HolidayDataSource = 'cache' | 'official-csv' | 'rule-based' | 'unavailable';

export interface HolidayData {
  year: number;
  holidays: Holiday[];
  source: HolidayDataSource;
  complete: boolean;
  synced_at: string | null;
}

export interface AttendanceWithDay extends Attendance {
  day_of_week: number;
  is_holiday: boolean;
  holiday_name: string | null;
  work_minutes: number | null;
}

export interface MonthlySummary {
  year: number;
  month: number;
  username: string;
  employee_name: string;
  office_days: number;
  remote_days: number;
  paid_leave_days: number;
  absent_days: number;
  scheduled_work_days: number;
  incomplete_days: number;
  total_work_minutes: number;
  total_transport_fee: number;
  overtime_minutes: number;
  overtime_threshold_minutes: number;
  default_one_way_fare: number;
  default_trip_type: TransportTripType;
  default_transport_mode: TransportMode;
  default_transport_origin: string;
  default_transport_destination: string;
  records: AttendanceWithDay[];
  holiday_data: Omit<HolidayData, 'holidays'>;
}

export interface PublicAppConfig {
  timezone: string;
  default_break_minutes: number;
  default_one_way_fare: number;
  default_trip_type: TransportTripType;
  default_clock_in: string | null;
  default_clock_out: string | null;
  overtime_threshold_hours: number;
}
