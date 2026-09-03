/**
 * The second Hand can deal SUITS, but can never alter the Jester's own
 * assignment. Callers must already have established that the actor is a
 * permitted SUITS dealer.
 */
export function canChangeSuitAssignment(actorJokerId: string, targetJokerId: string): boolean {
  return actorJokerId === "00-00" || targetJokerId !== "00-00";
}