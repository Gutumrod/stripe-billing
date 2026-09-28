export interface OneTimeEntitlementState {
  status: 'paid' | 'refunded';
  sourceAccessUntil: string | Date | null;
  updatesUntil: string | Date;
}

export function projectOneTimeAccess(state: OneTimeEntitlementState, now = Date.now()): {
  sourceAccessActive: boolean;
  updatesActive: boolean;
} {
  const paid = state.status === 'paid';
  const sourceExpiry = state.sourceAccessUntil === null ? null : new Date(state.sourceAccessUntil).getTime();
  const updateExpiry = new Date(state.updatesUntil).getTime();
  return {
    sourceAccessActive: paid && (sourceExpiry === null || (Number.isFinite(sourceExpiry) && now < sourceExpiry)),
    updatesActive: paid && Number.isFinite(updateExpiry) && now < updateExpiry,
  };
}
