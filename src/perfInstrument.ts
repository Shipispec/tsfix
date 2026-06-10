/**
 * Lightweight, opt-in perf instrumentation for the validate → fix pipeline.
 *
 * Records accumulated wall-clock time (and simple counters) per named span
 * into a process-global map. **Disabled by default** — `recordPerf`/`timePerf`
 * are no-ops unless instrumentation is turned on via `enablePerf()` or the
 * `TSFIX_PERF=1` env var. This keeps zero overhead on the normal hot path
 * while letting the benchmark harness collect a timing breakdown.
 *
 * Introduced for T-3c-1: baseline the lib-file double-load cost (Layer 0
 * `validatorInProcess` + Layer 1 `tsLanguageServiceFixer`) before the
 * shared-Program refactor (T-3c-2). See ARCHITECTURE.md §9.
 */

let forceEnabled = false;
let spans: Record<string, number> = {};

/** True when instrumentation should record. Default off. */
export function isPerfEnabled(): boolean {
	return forceEnabled || process.env.TSFIX_PERF === "1";
}

/** Turn instrumentation on for this process (used by the benchmark `--perf` flag). */
export function enablePerf(): void {
	forceEnabled = true;
}

/** Turn instrumentation off again (tests). */
export function disablePerf(): void {
	forceEnabled = false;
}

/** Clear all accumulated spans (call before each measured unit of work). */
export function resetPerf(): void {
	spans = {};
}

/** Add `ms` to the named span. No-op when instrumentation is disabled. */
export function recordPerf(label: string, ms: number): void {
	if (!isPerfEnabled()) return;
	spans[label] = (spans[label] ?? 0) + ms;
}

/**
 * Time `fn`, accumulating its wall-clock duration into the named span. When
 * instrumentation is disabled the timing calls are skipped and `fn` runs raw.
 */
export function timePerf<T>(label: string, fn: () => T): T {
	if (!isPerfEnabled()) return fn();
	const start = Date.now();
	try {
		return fn();
	} finally {
		recordPerf(label, Date.now() - start);
	}
}

/** Shallow copy of the current span map. */
export function snapshotPerf(): Record<string, number> {
	return { ...spans };
}
