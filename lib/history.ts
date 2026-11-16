export type HistoryRow = {
  date: string;
  modis: number | null;
  viirs: number | null;
  modisRaw?: number | null;
  viirsRaw?: number | null;
  /** Days with nationwide source records, NOT local clear-sky coverage. */
  modisObservedDays?: number;
  viirsObservedDays?: number;
  totalDays?: number;
  partialSensors?: string[];
};

export type HistoryRegion = {
  name: string;
  years?: number[];
  monthly: HistoryRow[];
  daily?: HistoryRow[];
  [key: string]: unknown;
};

export type SeriesMode = "adjusted" | "modis" | "viirs";

export interface HistoryCalibration {
  /** Per-calendar-month median MODIS/VIIRS ratios; null means insufficient fit data. */
  factors: (number | null)[];
  trainingMonths: number;
  trainingMonthsByMonth: number[];
  evaluationMonths: number;
  evaluationDates: string[];
  excludedTrainingPartialMonths: number;
  excludedEvaluationPartialMonths: number;
  /** Mean absolute difference in detected sensor-cell-days, not an accuracy estimate. */
  baselineError: number | null;
  adjustedError: number | null;
  coverageNote: string;
}

export const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const validCount = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function monthIndex(date: string): number | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.test(date)) return null;
  return Number(date.slice(5, 7)) - 1;
}

function monthlyRowsInYears(rows: readonly HistoryRow[], start: number, end: number): HistoryRow[] {
  return rows.filter((row) => row.date.length === 7 && monthIndex(row.date) !== null && Number(row.date.slice(0, 4)) >= start && Number(row.date.slice(0, 4)) <= end);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Detect KNOWN incomplete national availability. Missing metadata remains
 * unknown: this helper never interprets nationwide records as clear-sky local
 * observations. A null sensor with zero days and no partial flag may be outside
 * that sensor's historical era, and does not invalidate the other sensor.
 */
export function hasPartialAvailability(row: HistoryRow): boolean {
  if (row.partialSensors?.some((sensor) => ["MODIS", "VIIRS"].includes(sensor.toUpperCase()))) return true;
  const month = monthIndex(row.date);
  const expectedDays = row.totalDays ?? (month === null ? undefined : row.date.length === 7
    ? new Date(Date.UTC(Number(row.date.slice(0, 4)), month + 1, 0)).getUTCDate()
    : 1);
  if (expectedDays === undefined) return false;
  if (!Number.isInteger(expectedDays) || expectedDays < 1) return true;
  for (const sensor of ["modis", "viirs"] as const) {
    const availableDays = row[sensor === "modis" ? "modisObservedDays" : "viirsObservedDays"];
    if (availableDays === undefined) continue;
    if (!Number.isInteger(availableDays) || availableDays < 0 || availableDays > expectedDays) return true;
    // No data from an inactive sensor (e.g. VIIRS before 2012) is not a
    // partially measured month. Explicit partial flags above take precedence.
    if ((row[sensor] !== null || availableDays > 0) && availableDays < expectedDays) return true;
  }
  return false;
}

/**
 * Provisional seasonal comparison: fit 2012–2021, evaluate only 2022–2025.
 * Five complete, positive paired months per calendar month are required.
 * Known partial months are excluded from both fitting and held-out metrics.
 * Agreement with MODIS is a consistency check, not ground-truth fire accuracy.
 */
export function calibrate(rows: readonly HistoryRow[]): HistoryCalibration {
  const trainingPeriod = monthlyRowsInYears(rows, 2012, 2021);
  const evaluationPeriod = monthlyRowsInYears(rows, 2022, 2025);
  const training = trainingPeriod.filter((row) => !hasPartialAvailability(row) && validCount(row.modis) && validCount(row.viirs) && row.modis > 0 && row.viirs > 0);
  const trainingMonthsByMonth = Array.from({ length: 12 }, (_, month) => training.filter((row) => monthIndex(row.date) === month).length);
  const factors = trainingMonthsByMonth.map((count, month) => count >= 5
    ? median(training.filter((row) => monthIndex(row.date) === month).map((row) => row.modis! / row.viirs!))
    : null);
  const evaluation = evaluationPeriod.filter((row) => !hasPartialAvailability(row) && validCount(row.modis) && validCount(row.viirs) && factors[monthIndex(row.date)!] !== null);
  const baselineError = evaluation.length
    ? evaluation.reduce((sum, row) => sum + Math.abs(row.modis! - row.viirs!), 0) / evaluation.length
    : null;
  const adjustedError = evaluation.length
    ? evaluation.reduce((sum, row) => sum + Math.abs(row.modis! - row.viirs! * factors[monthIndex(row.date)!]!), 0) / evaluation.length
    : null;
  return {
    factors,
    trainingMonths: training.length,
    trainingMonthsByMonth,
    evaluationMonths: evaluation.length,
    evaluationDates: evaluation.map((row) => row.date).sort(),
    excludedTrainingPartialMonths: trainingPeriod.filter(hasPartialAvailability).length,
    excludedEvaluationPartialMonths: evaluationPeriod.filter(hasPartialAvailability).length,
    baselineError,
    adjustedError,
    coverageNote: "Availability flags identify missing nationwide source records; they do not measure local clear-sky observation coverage.",
  };
}

/** Raw modes retain incomplete recorded totals. The adjusted index does not. */
export function activityValue(row: HistoryRow, mode: SeriesMode, factors: readonly (number | null)[]): number | null {
  if (mode !== "adjusted") return validCount(row[mode]) ? row[mode] : null;
  if (hasPartialAvailability(row)) return null;
  const month = monthIndex(row.date);
  if (month === null) return null;
  const factor = factors[month];
  const modis = validCount(row.modis) ? row.modis : null;
  const scaledViirs = validCount(row.viirs) && typeof factor === "number" && Number.isFinite(factor) && factor > 0
    ? row.viirs * factor
    : null;
  if (modis !== null && scaledViirs !== null) return (modis + scaledViirs) / 2;
  // Preserve the MODIS-only historical era. Missing scale estimates never
  // become zero, and unscaled VIIRS is never mixed into this comparison index.
  return modis ?? scaledViirs;
}

/** Known partial months are omitted from seasonal norms, including raw modes. */
export function seasonalBaseline(rows: readonly HistoryRow[], mode: SeriesMode, factors: readonly (number | null)[]): (number | null)[] {
  const training = monthlyRowsInYears(rows, 2012, 2021).filter((row) => !hasPartialAvailability(row));
  return monthNames.map((_, month) => {
    const values = training.filter((row) => monthIndex(row.date) === month)
      .map((row) => activityValue(row, mode, factors)).filter((value): value is number => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  });
}
