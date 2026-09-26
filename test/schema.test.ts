import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface NameRow {
  name: string;
}

async function schemaNames(type: 'table' | 'index' | 'trigger'): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = ? AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  ).bind(type).all<NameRow>();
  return result.results
    .map((row) => row.name)
    .filter((name) => name !== 'd1_migrations' && !name.startsWith('_'));
}

async function columnNames(table: 'users' | 'attendance' | 'sessions'): Promise<string[]> {
  const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<NameRow>();
  return result.results.map((row) => row.name);
}

async function indexColumns(index: string): Promise<string[]> {
  const result = await env.DB.prepare(`PRAGMA index_info(${index})`).all<NameRow>();
  return result.results.map((row) => row.name);
}

describe('D1 final schema', () => {
  it('applies additive migrations and creates the complete schema', async () => {
    expect(env.TEST_MIGRATIONS.map((migration) => migration.name)).toEqual([
      '0001_schema.sql',
      '0002_attendance_revision.sql',
    ]);
    expect(env.TEST_MIGRATIONS[0]?.queries.join('\n')).toContain(
      'CREATE TRIGGER users_preserve_last_admin_delete',
    );

    expect(await schemaNames('table')).toEqual([
      'attendance',
      'audit_logs',
      'holiday_sync_failures',
      'holiday_sync_state',
      'holidays_cache',
      'sessions',
      'users',
    ]);

    expect(await schemaNames('index')).toEqual([
      'idx_attendance_date_user',
      'idx_audit_actor_created',
      'idx_audit_target_created',
      'idx_sessions_expires',
      'idx_sessions_user',
    ]);

    expect(await schemaNames('trigger')).toEqual([
      'attendance_audit_delete',
      'attendance_audit_insert',
      'attendance_audit_update',
      'users_preserve_last_admin_delete',
      'users_preserve_last_admin_update',
      'users_username_immutable',
    ]);

    expect(await columnNames('users')).toEqual([
      'id',
      'username',
      'password_hash',
      'display_name',
      'is_admin',
      'default_one_way_fare',
      'default_trip_type',
      'default_transport_mode',
      'default_transport_origin',
      'default_transport_destination',
      'default_clock_in',
      'default_clock_out',
      'default_break_minutes',
      'default_work_type',
      'auth_version',
      'created_at',
    ]);

    expect(await columnNames('attendance')).toEqual([
      'id',
      'user_id',
      'work_date',
      'work_type',
      'clock_in',
      'clock_out',
      'break_minutes',
      'transport_fee',
      'transport_one_way_fee',
      'transport_trip_type',
      'transport_mode',
      'transport_origin',
      'transport_destination',
      'memo',
      'created_at',
      'updated_at',
      'revision',
    ]);
    expect(await columnNames('sessions')).toEqual([
      'token_id',
      'user_id',
      'expires_at',
      'reauthenticated_at',
      'reauth_token_hash',
      'auth_version',
      'created_at',
    ]);

    expect(await indexColumns('idx_attendance_date_user')).toEqual([
      'work_date',
      'user_id',
    ]);
    expect(await indexColumns('sqlite_autoindex_attendance_1')).toEqual([
      'user_id',
      'work_date',
    ]);

    const foreignKeyCheck = await env.DB.prepare('PRAGMA foreign_key_check').all();
    expect(foreignKeyCheck.results).toEqual([]);
  });
});
