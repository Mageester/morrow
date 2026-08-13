export interface ProcessOutputObservation {
  status: string;
  offset: number;
  nextOffset: number;
}

export interface ProcessOutputInterval {
  start: number;
  end: number;
}

export interface ProcessObservationState {
  statuses: readonly string[];
  coveredIntervals: readonly ProcessOutputInterval[];
}

export interface ProcessObservationProgress {
  progress: boolean;
  state: ProcessObservationState;
}

function getObservedInterval(observation: ProcessOutputObservation): ProcessOutputInterval | undefined {
  if (!Number.isFinite(observation.offset) || !Number.isFinite(observation.nextOffset)) return undefined;
  const start = Math.max(0, Math.floor(observation.offset));
  const end = Math.floor(observation.nextOffset);
  return end > start ? { start, end } : undefined;
}

function hasUncoveredBytes(
  interval: ProcessOutputInterval,
  coveredIntervals: readonly ProcessOutputInterval[],
): boolean {
  let cursor = interval.start;
  for (const covered of coveredIntervals) {
    if (covered.end <= cursor) continue;
    if (covered.start > cursor) return true;
    cursor = Math.max(cursor, covered.end);
    if (cursor >= interval.end) return false;
  }
  return cursor < interval.end;
}

function mergeCoveredInterval(
  coveredIntervals: readonly ProcessOutputInterval[],
  incoming: ProcessOutputInterval,
): readonly ProcessOutputInterval[] {
  const sorted = [...coveredIntervals, incoming]
    .filter((interval) => interval.end > interval.start)
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: ProcessOutputInterval[] = [];

  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push(interval);
    }
  }

  return merged;
}

/** Seed the status known from the owned process record without crediting it. */
export function seedProcessObservationStatus(
  previous: ProcessObservationState | undefined,
  status: string,
): ProcessObservationState {
  const state = previous ?? { statuses: [], coveredIntervals: [] };
  if (state.statuses.includes(status)) return state;
  return { ...state, statuses: [...state.statuses, status] };
}

/**
 * Credit one status transition or one byte interval containing output not
 * previously covered for this process and stream. Empty and offset-only
 * slices do not change output coverage.
 */
export function observeProcessOutputProgress(
  previous: ProcessObservationState,
  observation: ProcessOutputObservation,
): ProcessObservationProgress {
  const statuses = previous.statuses.includes(observation.status)
    ? previous.statuses
    : [...previous.statuses, observation.status];
  const observedInterval = getObservedInterval(observation);
  const outputProgress = observedInterval
    ? hasUncoveredBytes(observedInterval, previous.coveredIntervals)
    : false;
  const statusChanged = !previous.statuses.includes(observation.status);

  return {
    progress: statusChanged || outputProgress,
    state: {
      statuses,
      coveredIntervals: observedInterval && outputProgress
        ? mergeCoveredInterval(previous.coveredIntervals, observedInterval)
        : previous.coveredIntervals,
    },
  };
}
