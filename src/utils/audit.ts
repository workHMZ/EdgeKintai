const PRECISE_ROUTE_FIELDS = new Set([
  'default_transport_origin',
  'default_transport_destination',
  'transport_origin',
  'transport_destination',
]);

export function stringifyAuditJson(value: unknown): string {
  return JSON.stringify(value, (key, nestedValue) => (
    PRECISE_ROUTE_FIELDS.has(key) ? undefined : nestedValue
  ));
}

export function userAuditStatement(
  env: CloudflareBindings,
  actorId: number,
  targetId: number,
  action: string,
  before: unknown,
  after: unknown,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_logs (
       actor_user_id, target_user_id, action, entity_type, entity_key, before_json, after_json
     ) VALUES (?, ?, ?, 'user', ?, ?, ?)`,
  ).bind(
    actorId,
    targetId,
    action,
    String(targetId),
    before === null ? null : stringifyAuditJson(before),
    after === null ? null : stringifyAuditJson(after),
  );
}
