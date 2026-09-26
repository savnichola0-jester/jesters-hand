/**
 * Both pinned Hand seats have the same SUITS management authority. Callers
 * still establish the actor's active admin record before using this helper.
 */
export function canChangeSuitAssignment(actorJokerId: string, _targetJokerId: string): boolean {
  return actorJokerId === "00-00" || actorJokerId === "01-54";
}

/** Change only assigned pips; all historical SUITS progress stays untouched. */
export function withSuitAssignment<T extends Record<string, unknown>>(
  assignment: T,
  pip: string,
  assigned: boolean,
): T & { pips: string[] } {
  const pips = Array.isArray(assignment.pips) ? assignment.pips.filter((value): value is string => typeof value === "string") : [];
  return {
    ...assignment,
    pips: assigned
      ? (pips.includes(pip) ? pips : [...pips, pip])
      : pips.filter(value => value !== pip),
  };
}

/** Royal awards remain exclusive to the permanent 00-00 Jester seat. */
export function canAwardRoyal(actorJokerId: string): boolean {
  return actorJokerId === "00-00";
}