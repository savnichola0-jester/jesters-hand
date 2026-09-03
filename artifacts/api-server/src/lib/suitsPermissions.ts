/**
 * Both pinned Hand seats have the same SUITS management authority. Callers
 * still establish the actor's active admin record before using this helper.
 */
export function canChangeSuitAssignment(actorJokerId: string, _targetJokerId: string): boolean {
  return actorJokerId === "00-00" || actorJokerId === "01-54";
}

/** Royal awards remain exclusive to the permanent 00-00 Jester seat. */
export function canAwardRoyal(actorJokerId: string): boolean {
  return actorJokerId === "00-00";
}