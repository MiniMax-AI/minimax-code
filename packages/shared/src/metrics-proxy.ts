export type MetricType = 'counter' | 'gauge' | 'histogram';

export type MetricLabels = Record<string, string>;

export type MetricPoint =
  | {
      type: 'counter';
      name: string;
      labels?: MetricLabels;
      value: number;
      updatedAt?: number;
    }
  | {
      type: 'gauge';
      name: string;
      labels?: MetricLabels;
      value: number;
      updatedAt?: number;
    }
  | {
      type: 'histogram';
      name: string;
      labels?: MetricLabels;
      count: number;
      sum: number;
      buckets: Record<string, number>;
      updatedAt?: number;
    };

export interface ReportMetricsBatchRequest {
  service: string;
  timestamp?: number;
  metrics: MetricPoint[];
}

export interface ReportMetricsBatchResponse {
  accepted?: number;
}

export interface MetricsBatchReporter {
  reportBatch(req: ReportMetricsBatchRequest): Promise<ReportMetricsBatchResponse>;
}

export interface MetricsReporterOptions {
  endpoint?: string;
  batchPath?: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  reportMetric?: (
    metric: MetricPoint,
    context: { service: string; timestamp?: number },
  ) => Promise<void> | void;
}

/**
 * Retry queue of the default delivery: a batch that fails with a retryable
 * error is kept and sent again with the next flushes, `maxAttempts` sends in
 * all. A batch whose sends ran out, or that the full queue pushes out, puts its
 * counter and histogram deltas back into the pending series, so the next flush
 * sends them once. Past `maxCarryOverSeries` series put back since the last
 * flush, merged ones included, or at `maxSeries`, new series are dropped and
 * reported to `onError`. `baseDelayMs` and `maxDelayMs` are not
 * read; the next flush is the retry.
 */
export interface MetricsClientRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryBatches?: number;
  maxRetryMetrics?: number;
  /** Series given-up batches may put back between flushes, merged ones included. Default 10_000. */
  maxCarryOverSeries?: number;
}

/** The shipped delivery: the retry queue of {@link MetricsClientRetryOptions}. */
interface MetricsRetryQueueDelivery {
  readonly mode: 'retry_queue';
}

/**
 * Carry-over delivery (Desktop). A send that gets no response (network error,
 * timeout) or 429, 502, 503 or 504 puts the counter and histogram deltas of its
 * batch back into the pending series, where they add up with what is recorded
 * meanwhile, and the client backs off; there is no attempt limit and no retry
 * queue. Any other status drops the batch and counts its points as
 * `non_retryable_status`. Past `maxCarryOverSeries` series put back since
 * the last flush, merged ones included, or at `maxSeries`, the new series of
 * a failed batch are dropped and counted as `series_limit`. The counts go out as `metrics_client_dropped_points_total`
 * in a request of their own.
 *
 * A request the server processed but answered after the timeout is sent again
 * with the next flush, so those counts are counted twice.
 */
interface MetricsCarryOverDelivery {
  readonly mode: 'carry_over';
  /** Series failed flushes may put back between flushes, merged ones included. Default 10_000. */
  readonly maxCarryOverSeries?: number;
  /** Wait after the first failed send; it doubles per consecutive failure. Default 5_000. */
  readonly baseDelayMs?: number;
  /** Cap of the wait, jitter included. Default 60_000. */
  readonly maxDelayMs?: number;
  /** Jitter source in [0, 1); each wait is stretched by up to half. Default Math.random. */
  readonly random?: () => number;
}

export type MetricsDelivery = MetricsRetryQueueDelivery | MetricsCarryOverDelivery;

export interface MetricsClientOptions {
  reporter: MetricsBatchReporter;
  serviceName: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxSeries?: number;
  maxLabelKeys?: number;
  maxLabelValueLength?: number;
  defaultLabels?: MetricLabels;
  histogramBuckets?: number[];
  histogramBucketsByName?: Record<string, number[]>;
  stickyGauge?: boolean;
  retry?: MetricsClientRetryOptions;
  /** How undelivered points are handled. Default: the shipped retry queue. */
  delivery?: MetricsDelivery;
  onError?: (error: unknown) => void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface CreateMetricsClientOptions
  extends Omit<MetricsClientOptions, 'reporter' | 'serviceName'>, MetricsReporterOptions {
  serviceName: string;
}

export interface CreateDesktopReporterOptions extends Omit<
  MetricsReporterOptions,
  'endpoint' | 'batchPath' | 'reportMetric'
> {
  configuredDomainUrl?: string;
  isEn: boolean;
  isProd: boolean;
  isStaging?: boolean;
  isDev?: boolean;
}

interface MetricStorePoint {
  name: string;
  labels: MetricLabels;
  updatedAt: number;
}

interface CounterStorePoint extends MetricStorePoint {
  value: number;
}

interface GaugeStorePoint extends MetricStorePoint {
  value: number;
}

interface HistogramStorePoint extends MetricStorePoint {
  buckets: number[];
  bucketCounts: number[];
  count: number;
  sum: number;
}

interface RetryBatch {
  request: ReportMetricsBatchRequest;
  attempts: number;
}

/** Normalized options of carry-over delivery. */
type CarryOverPolicy = Required<Omit<MetricsCarryOverDelivery, 'mode'>>;

/** Self-report of points the client gave up on, registered in the metric registry. */
export const METRICS_CLIENT_DROPPED_POINTS_METRIC = 'metrics_client_dropped_points_total';
export const METRICS_DROP_REASONS = ['non_retryable_status', 'series_limit'] as const;
export type MetricsDropReason = (typeof METRICS_DROP_REASONS)[number];

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 1_000;
const DEFAULT_MAX_SERIES = 50_000;
const DEFAULT_MAX_LABEL_KEYS = 20;
const DEFAULT_MAX_LABEL_VALUE_LENGTH = 512;
const DEFAULT_HISTOGRAM_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  maxRetryBatches: 100,
  maxRetryMetrics: 100_000,
  maxCarryOverSeries: 10_000,
};
// The first wait is one flush interval and the cap a minute, so an outage costs
// each client at most one request a minute and a recovered network is used
// again within a minute.
const DEFAULT_CARRY_OVER = {
  maxCarryOverSeries: 10_000,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
};
/** Statuses carry-over delivery sends again; any other answer is final (as OTLP exporters do). */
const CARRY_OVER_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const DEFAULT_METRICS_BATCH_PATH = '/matrix/api/v1/metrics/batch';
export const DESKTOP_METRICS_BATCH_PATH = '/matrix/api/v1/metrics/batch';

export class MetricsReportError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable: boolean }) {
    super(message);
    this.name = 'MetricsReportError';
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

export class MetricsReporter implements MetricsBatchReporter {
  private readonly options: MetricsReporterOptions;

  constructor(options: MetricsReporterOptions) {
    this.options = {
      ...options,
      ...(options.endpoint
        ? {
            endpoint: options.endpoint.replace(/\/+$/, ''),
            batchPath: normalizeBatchPath(options.batchPath ?? DEFAULT_METRICS_BATCH_PATH),
          }
        : {}),
    };
  }

  async reportBatch(req: ReportMetricsBatchRequest): Promise<ReportMetricsBatchResponse> {
    if (!this.options.endpoint) {
      if (!this.options.reportMetric) {
        throw new MetricsReportError('Metrics reporter requires either endpoint or reportMetric', {
          retryable: false,
        });
      }

      for (const metric of req.metrics) {
        await this.options.reportMetric(metric, {
          service: req.service,
          timestamp: req.timestamp,
        });
      }

      return { accepted: req.metrics.length };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 3_000);

    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.endpoint}${this.options.batchPath}`,
        {
          method: 'POST',
          headers: {
            ...(this.options.headers ?? {}),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(toReportBody(req)),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new MetricsReportError(`Metrics report failed with HTTP ${response.status}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      return (await response.json().catch(() => ({}))) as ReportMetricsBatchResponse;
    } catch (error) {
      if (error instanceof MetricsReportError) {
        throw error;
      }

      throw new MetricsReportError('Metrics report failed before a response was received', {
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class MetricsClient {
  private readonly reporter: MetricsBatchReporter;
  private readonly serviceName: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxSeries: number;
  private readonly maxLabelKeys: number;
  private readonly maxLabelValueLength: number;
  private readonly defaultLabels: MetricLabels;
  private readonly histogramBuckets: number[];
  private readonly histogramBucketsByName: Record<string, number[]>;
  private readonly stickyGauge: boolean;
  private readonly retry: Required<MetricsClientRetryOptions>;
  /** Set for carry-over delivery; the retry queue is used otherwise. */
  private readonly carryOver: CarryOverPolicy | undefined;
  private readonly onError?: (error: unknown) => void;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly counters = new Map<string, CounterStorePoint>();
  private readonly gauges = new Map<string, GaugeStorePoint>();
  private readonly histograms = new Map<string, HistogramStorePoint>();
  private readonly metricNameSeriesCounts = new Map<string, Set<string>>();
  private readonly retryBuffer: RetryBatch[] = [];
  private readonly droppedPoints = new Map<MetricsDropReason, number>();
  private readonly collectors = new Set<() => void>();
  private collecting = false;
  /** Series put back since the last snapshot, merged ones included. */
  private readonly carriedKeys = new Set<string>();
  private consecutiveFailures = 0;
  private retryAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Flushes run one at a time in call order; the tail of that chain. */
  private flushChain: Promise<void> = Promise.resolve();
  /** Flushes queued or running. */
  private flushesPending = 0;
  private closed = false;

  constructor(options: MetricsClientOptions) {
    this.reporter = options.reporter;
    this.serviceName = options.serviceName;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
    this.maxLabelKeys = options.maxLabelKeys ?? DEFAULT_MAX_LABEL_KEYS;
    this.maxLabelValueLength = options.maxLabelValueLength ?? DEFAULT_MAX_LABEL_VALUE_LENGTH;
    this.defaultLabels = normalizeLabels(options.defaultLabels ?? {});
    this.histogramBuckets = normalizeBuckets(options.histogramBuckets ?? DEFAULT_HISTOGRAM_BUCKETS);
    this.histogramBucketsByName = Object.fromEntries(
      Object.entries(options.histogramBucketsByName ?? {}).map(([name, buckets]) => [
        name,
        normalizeBuckets(buckets),
      ]),
    );
    this.stickyGauge = options.stickyGauge ?? false;
    this.retry = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
    this.carryOver = carryOverPolicy(options.delivery);
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;

    if (this.flushIntervalMs > 0) {
      this.scheduleFlush();
    }
  }

  counter(name: string, delta = 1, labels: MetricLabels = {}): void {
    if (this.closed || !Number.isFinite(delta) || delta <= 0) return;
    const mergedLabels = this.validateAndMergeLabels('counter', name, labels);
    if (!mergedLabels) return;

    const key = buildMetricKey('counter', name, mergedLabels);
    const existing = this.counters.get(key);
    const updatedAt = this.now();
    if (existing) {
      existing.value += delta;
      existing.updatedAt = updatedAt;
    } else {
      this.counters.set(key, { name, labels: mergedLabels, value: delta, updatedAt });
    }
    this.flushWhenFull();
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    if (this.closed || !Number.isFinite(value)) return;
    const mergedLabels = this.validateAndMergeLabels('gauge', name, labels);
    if (!mergedLabels) return;

    this.gauges.set(buildMetricKey('gauge', name, mergedLabels), {
      name,
      labels: mergedLabels,
      value,
      updatedAt: this.now(),
    });
    this.flushWhenFull();
  }

  histogram(name: string, value: number, labels: MetricLabels = {}): void {
    if (this.closed || !Number.isFinite(value)) return;
    const mergedLabels = this.validateAndMergeLabels('histogram', name, labels);
    if (!mergedLabels) return;

    const key = buildMetricKey('histogram', name, mergedLabels);
    const buckets = this.histogramBucketsByName[name] ?? this.histogramBuckets;
    let point = this.histograms.get(key);
    if (!point) {
      point = {
        name,
        labels: mergedLabels,
        buckets,
        bucketCounts: buckets.map(() => 0),
        count: 0,
        sum: 0,
        updatedAt: this.now(),
      };
      this.histograms.set(key, point);
    }

    point.count += 1;
    point.sum += value;
    point.updatedAt = this.now();
    for (let index = 0; index < point.buckets.length; index += 1) {
      const bucket = point.buckets[index];
      if (bucket !== undefined && value <= bucket) {
        point.bucketCounts[index] = (point.bucketCounts[index] ?? 0) + 1;
      }
    }
    this.flushWhenFull();
  }

  /**
   * Run `collect` right before every snapshot, so a module can report what
   * accrued since the previous one, such as busy time or a queue's depth. What
   * it reports joins that snapshot and never starts a flush of its own.
   * Returns the function that removes it.
   */
  onCollect(collect: () => void): () => void {
    this.collectors.add(collect);
    return () => {
      this.collectors.delete(collect);
    };
  }

  /** Send now; carry-over delivery does not wait for its backoff to end. */
  async flush(): Promise<void> {
    await this.flushSerialized(true);
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      this.clearTimer(this.flushTimer);
      this.flushTimer = undefined;
    }
    // Collect while points are still accepted; the final flush below skips it.
    this.runCollectors();
    this.closed = true;
    await this.flushSerialized(true);
  }

  private runCollectors(): void {
    if (this.closed || this.collecting) return;
    this.collecting = true;
    try {
      for (const collect of this.collectors) {
        try {
          collect();
        } catch (error) {
          this.onError?.(error);
        }
      }
    } finally {
      this.collecting = false;
    }
  }

  /**
   * Flushes never overlap: an idle client starts at once, as it always did,
   * and a flush asked for while one runs waits for it. Collectors report inside
   * the flush, so they cannot start another one (see flushWhenFull).
   */
  private flushSerialized(force: boolean): Promise<void> {
    this.flushesPending += 1;
    const run =
      this.flushesPending === 1
        ? this.flushOnce(force)
        : this.flushChain.then(() => this.flushOnce(force));
    const settled = run.finally(() => {
      this.flushesPending -= 1;
    });
    this.flushChain = settled.catch(() => undefined);
    return settled;
  }

  private async flushOnce(force: boolean): Promise<void> {
    if (this.carryOver) {
      await this.flushCarryingOver(force, this.carryOver);
      return;
    }
    this.runCollectors();
    const snapshot = this.takeSnapshot();
    if (snapshot.length === 0 && this.retryBuffer.length === 0) return;

    await this.drainRetryBuffer();

    for (const metrics of chunk(snapshot, this.maxBatchSize)) {
      await this.sendOrBuffer({
        service: this.serviceName,
        timestamp: this.now(),
        metrics,
      });
    }
  }

  private async drainRetryBuffer(): Promise<void> {
    const pending = this.retryBuffer.splice(0, this.retryBuffer.length);
    for (const batch of pending) {
      await this.sendOrBuffer(batch.request, batch.attempts);
    }
  }

  private async sendOrBuffer(request: ReportMetricsBatchRequest, attempts = 0): Promise<void> {
    if (request.metrics.length === 0) return;

    try {
      await this.reporter.reportBatch(request);
    } catch (error) {
      if (!isRetryableError(error)) {
        // The endpoint refused the batch itself; sending it again cannot succeed.
        this.onError?.(error);
      } else if (attempts + 1 < this.retry.maxAttempts) {
        this.pushRetryBatch({ request, attempts: attempts + 1 });
      } else {
        this.onError?.(error);
        this.carryOverGivenUp(request.metrics);
      }
    }
  }

  private pushRetryBatch(batch: RetryBatch): void {
    this.retryBuffer.push(batch);

    while (
      this.retryBuffer.length > this.retry.maxRetryBatches ||
      this.retryBuffer.reduce((total, item) => total + item.request.metrics.length, 0) >
        this.retry.maxRetryMetrics
    ) {
      const dropped = this.retryBuffer.shift();
      if (!dropped) break;
      this.onError?.(
        new MetricsReportError('Metrics retry buffer exceeded its limit; dropped oldest batch', {
          retryable: false,
        }),
      );
      this.carryOverGivenUp(dropped.request.metrics);
    }
  }

  /**
   * Retry queue delivery: a batch that will not be sent again puts its counter
   * and histogram deltas back into the pending series, so the next flush sends
   * them once. New series that do not fit are dropped and reported.
   */
  private carryOverGivenUp(metrics: readonly MetricPoint[]): void {
    const dropped = this.putBack(metrics, false, this.retry.maxCarryOverSeries);
    if (dropped === 0) return;
    this.onError?.(
      new MetricsReportError(`Metrics carry-over limit reached; dropped ${dropped} series`, {
        retryable: false,
      }),
    );
  }

  /**
   * Carry-over delivery: send the pending series in batches of `maxBatchSize`,
   * in order. A retryable failure ends the round: that batch and the ones not
   * sent yet go back into the pending series and the client backs off. The
   * dropped-points report follows the data in a request of its own.
   */
  private async flushCarryingOver(force: boolean, policy: CarryOverPolicy): Promise<void> {
    // While backing off, points keep adding up per series; only flush() and close() send.
    if (!force && this.now() < this.retryAt) return;
    this.runCollectors();
    const batches = chunk(this.takeSnapshot(), this.maxBatchSize);
    for (const [index, metrics] of batches.entries()) {
      if (!(await this.sendCarryingOver(metrics))) {
        let dropped = this.putBack(metrics, false, policy.maxCarryOverSeries);
        for (const unsent of batches.slice(index + 1))
          dropped += this.putBack(unsent, true, policy.maxCarryOverSeries);
        if (dropped > 0) this.countDropped('series_limit', dropped);
        this.backOff(policy);
        return;
      }
    }
    await this.sendDroppedPoints(policy);
  }

  /** Returns false when the batch is to be sent again. */
  private async sendCarryingOver(metrics: MetricPoint[]): Promise<boolean> {
    try {
      await this.reporter.reportBatch({
        service: this.serviceName,
        timestamp: this.now(),
        metrics,
      });
    } catch (error) {
      if (isCarryOverRetryable(error)) return false;
      this.countDropped('non_retryable_status', metrics.length);
      this.onError?.(error);
      return true;
    }
    this.deliveryRecovered();
    return true;
  }

  /** A retryable failure keeps the counts for the next round; any other drops them. */
  private async sendDroppedPoints(policy: CarryOverPolicy): Promise<void> {
    if (this.droppedPoints.size === 0) return;
    const metrics = this.takeDroppedPoints();
    try {
      await this.reporter.reportBatch({
        service: this.serviceName,
        timestamp: this.now(),
        metrics,
      });
    } catch (error) {
      if (isCarryOverRetryable(error)) {
        this.restoreDroppedPoints(metrics);
        this.backOff(policy);
      } else {
        this.onError?.(error);
      }
      return;
    }
    this.deliveryRecovered();
  }

  /**
   * Put an undelivered batch back into the pending series. Counter and
   * histogram deltas add to what was recorded since; a gauge comes back only
   * from a batch never sent, and only when no newer value is pending. A series
   * put back counts toward `maxCarryOverSeries` until the next snapshot, and one
   * not pending is dropped past it or past `maxSeries`; returns how many were
   * dropped. Closing does not stop it: what a flush still in flight puts back
   * goes out with the final flush.
   */
  private putBack(
    metrics: readonly MetricPoint[],
    keepGauges: boolean,
    maxCarryOverSeries: number,
  ): number {
    let dropped = 0;
    for (const metric of metrics) {
      const labels = metric.labels ?? {};
      const key = buildMetricKey(metric.type, metric.name, labels);
      if (metric.type === 'gauge') {
        if (!keepGauges || this.gauges.has(key)) continue;
        if (this.carriedKeys.size >= maxCarryOverSeries || this.seriesCount() >= this.maxSeries) {
          dropped += 1;
          continue;
        }
        this.gauges.set(key, {
          name: metric.name,
          labels,
          value: metric.value,
          updatedAt: metric.updatedAt ?? this.now(),
        });
        this.carriedKeys.add(key);
        continue;
      }
      const pending = metric.type === 'counter' ? this.counters.has(key) : this.histograms.has(key);
      if (
        !pending &&
        (this.carriedKeys.size >= maxCarryOverSeries || this.seriesCount() >= this.maxSeries)
      ) {
        dropped += 1;
        continue;
      }
      this.carriedKeys.add(key);
      if (metric.type === 'counter') this.carryCounter(key, metric, labels);
      else this.carryHistogram(key, metric, labels);
    }
    return dropped;
  }

  private carryCounter(
    key: string,
    metric: Extract<MetricPoint, { type: 'counter' }>,
    labels: MetricLabels,
  ): void {
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += metric.value;
      return;
    }
    this.counters.set(key, {
      name: metric.name,
      labels,
      value: metric.value,
      updatedAt: metric.updatedAt ?? this.now(),
    });
  }

  private carryHistogram(
    key: string,
    metric: Extract<MetricPoint, { type: 'histogram' }>,
    labels: MetricLabels,
  ): void {
    let point = this.histograms.get(key);
    if (!point) {
      const buckets = normalizeBuckets(Object.keys(metric.buckets).map(Number));
      point = {
        name: metric.name,
        labels,
        buckets,
        bucketCounts: buckets.map(() => 0),
        count: 0,
        sum: 0,
        updatedAt: metric.updatedAt ?? this.now(),
      };
      this.histograms.set(key, point);
    }
    point.count += metric.count;
    point.sum += metric.sum;
    point.buckets.forEach((bucket, index) => {
      point.bucketCounts[index] =
        (point.bucketCounts[index] ?? 0) + (metric.buckets[String(bucket)] ?? 0);
    });
  }

  /** Wait base × 2^(failures − 1), stretched by up to half for jitter, at most maxDelayMs. */
  private backOff(policy: CarryOverPolicy): void {
    this.consecutiveFailures += 1;
    const sample = policy.random();
    const jitter = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
    const doubled = policy.baseDelayMs * 2 ** (this.consecutiveFailures - 1);
    this.retryAt = this.now() + Math.min(policy.maxDelayMs, doubled * (1 + jitter / 2));
  }

  private deliveryRecovered(): void {
    if (this.consecutiveFailures === 0) return;
    this.consecutiveFailures = 0;
    this.retryAt = 0;
    // A forced flush ended the backoff: the timer waiting for it is too late now.
    if (this.flushTimer && !this.closed) {
      this.clearTimer(this.flushTimer);
      this.scheduleFlush();
    }
  }

  private countDropped(reason: MetricsDropReason, points: number): void {
    this.droppedPoints.set(reason, (this.droppedPoints.get(reason) ?? 0) + points);
  }

  private takeDroppedPoints(): MetricPoint[] {
    const points: MetricPoint[] = [...this.droppedPoints].map(([reason, value]) => ({
      type: 'counter' as const,
      name: METRICS_CLIENT_DROPPED_POINTS_METRIC,
      labels: normalizeLabels({ ...this.defaultLabels, reason }),
      value,
      updatedAt: this.now(),
    }));
    this.droppedPoints.clear();
    return points;
  }

  private restoreDroppedPoints(points: readonly MetricPoint[]): void {
    for (const point of points) {
      const reason = point.labels?.reason as MetricsDropReason;
      if (point.type === 'counter') this.countDropped(reason, point.value);
    }
  }

  private seriesCount(): number {
    return this.counters.size + this.gauges.size + this.histograms.size;
  }

  private takeSnapshot(): MetricPoint[] {
    const points: MetricPoint[] = [];
    this.carriedKeys.clear();

    for (const point of this.counters.values()) {
      points.push({
        type: 'counter',
        name: point.name,
        labels: point.labels,
        value: point.value,
        updatedAt: point.updatedAt,
      });
    }
    this.counters.clear();

    for (const point of this.gauges.values()) {
      points.push({
        type: 'gauge',
        name: point.name,
        labels: point.labels,
        value: point.value,
        updatedAt: point.updatedAt,
      });
    }
    if (!this.stickyGauge) {
      this.gauges.clear();
    }

    for (const point of this.histograms.values()) {
      points.push({
        type: 'histogram',
        name: point.name,
        labels: point.labels,
        count: point.count,
        sum: point.sum,
        buckets: Object.fromEntries(
          point.buckets.map((bucket, index) => [String(bucket), point.bucketCounts[index] ?? 0]),
        ),
        updatedAt: point.updatedAt,
      });
    }
    this.histograms.clear();

    return points;
  }

  private validateAndMergeLabels(
    type: MetricType,
    name: string,
    labels: MetricLabels,
  ): MetricLabels | null {
    if (!METRIC_NAME_RE.test(name)) {
      this.onError?.(new Error(`Invalid metric name: ${name}`));
      return null;
    }

    const merged = normalizeLabels({ ...this.defaultLabels, ...labels });
    const labelEntries = Object.entries(merged);
    if (labelEntries.length > this.maxLabelKeys) {
      this.onError?.(new Error(`Metric ${name} has too many label keys`));
      return null;
    }

    if (labelEntries.some(([, value]) => value.length > this.maxLabelValueLength)) {
      this.onError?.(new Error(`Metric ${name} has a label value exceeding max length`));
      return null;
    }

    const key = buildMetricKey(type, name, merged);
    if (!this.canAcceptSeries(name, key)) {
      this.onError?.(new Error(`Metric series limit exceeded for ${name}`));
      return null;
    }

    return merged;
  }

  private canAcceptSeries(name: string, key: string): boolean {
    if (this.counters.has(key) || this.gauges.has(key) || this.histograms.has(key)) {
      return true;
    }

    if (this.seriesCount() >= this.maxSeries) {
      return false;
    }

    let nameSeries = this.metricNameSeriesCounts.get(name);
    if (!nameSeries) {
      nameSeries = new Set<string>();
      this.metricNameSeriesCounts.set(name, nameSeries);
    }
    nameSeries.add(key);
    return true;
  }

  private flushWhenFull(): void {
    // A collector reports inside a flush, which sends its points itself.
    if (this.collecting) return;
    // One flush at a time: a waiting flush takes these points with its snapshot, and after a
    // running one the next point, the interval or close() sends them. Queueing one per point
    // would resend every kept batch per point while the endpoint is down.
    if (this.flushesPending > 0) return;
    // Carry-over delivery leaves a backoff alone; the next due flush sends.
    if (this.carryOver && this.now() < this.retryAt) return;
    // Carried-over series wait for the next due flush, so an outage never flushes per call.
    if (this.seriesCount() - this.carriedKeys.size >= this.maxBatchSize) {
      void this.flushSerialized(false).catch((error) => this.onError?.(error));
    }
  }

  private scheduleFlush(): void {
    // Backing off, carry-over delivery waits for the backoff instead of the interval.
    const wait = Math.max(this.flushIntervalMs, this.retryAt - this.now());
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = undefined;
      void this.flushSerialized(false)
        .catch((error) => this.onError?.(error))
        .finally(() => {
          if (!this.closed && !this.flushTimer) {
            this.scheduleFlush();
          }
        });
    }, wait);
    this.flushTimer.unref?.();
  }
}

export function createMetricsClient(options: CreateMetricsClientOptions): MetricsClient {
  const reporter = new MetricsReporter(options);

  return new MetricsClient({
    ...options,
    reporter,
    serviceName: options.serviceName,
  });
}

export function createDesktopReporter(options: CreateDesktopReporterOptions): MetricsReporter {
  return new MetricsReporter({
    ...options,
    endpoint: resolveDesktopDomainUrl(options),
    batchPath: DESKTOP_METRICS_BATCH_PATH,
  });
}

export function buildMetricKey(type: MetricType, name: string, labels: MetricLabels = {}): string {
  const labelText = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(',');

  return `${type}:${name}{${labelText}}`;
}

function normalizeLabels(labels: MetricLabels): MetricLabels {
  return Object.fromEntries(
    Object.entries(labels)
      .filter(([key, value]) => key.length > 0 && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeBuckets(buckets: number[]): number[] {
  return [...new Set(buckets.filter((bucket) => Number.isFinite(bucket)))].sort((a, b) => a - b);
}

function normalizeBatchPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return DEFAULT_METRICS_BATCH_PATH;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function resolveDesktopDomainUrl(options: CreateDesktopReporterOptions): string {
  const configuredDomainUrl = options.configuredDomainUrl?.trim();
  if (configuredDomainUrl) return configuredDomainUrl;

  if (options.isEn) {
    if (options.isProd) return 'https://agent.minimax.io';
    if (options.isStaging) return 'https://matrix-overseas-pre.example.invalid';
    if (options.isDev) return 'https://matrix-overseas-test.example.invalid';
    return 'https://matrix-overseas-test.example.invalid';
  }

  if (options.isProd) return 'https://agent.minimax.cn';
  if (options.isStaging) return 'https://matrix-pre.example.invalid';
  if (options.isDev) return 'https://matrix-test.example.invalid';
  return 'https://matrix-test.example.invalid';
}

function isRetryableError(error: unknown): boolean {
  return error instanceof MetricsReportError ? error.retryable : true;
}

/**
 * Carry-over delivery sends again what got no response (network error,
 * timeout, or an error that is not a report failure) or 429, 502, 503, 504.
 */
function isCarryOverRetryable(error: unknown): boolean {
  if (!(error instanceof MetricsReportError)) return true;
  if (error.status === undefined) return error.retryable;
  return CARRY_OVER_RETRY_STATUSES.has(error.status);
}

function carryOverPolicy(delivery: MetricsDelivery | undefined): CarryOverPolicy | undefined {
  if (delivery?.mode !== 'carry_over') return undefined;
  return {
    maxCarryOverSeries: delivery.maxCarryOverSeries ?? DEFAULT_CARRY_OVER.maxCarryOverSeries,
    baseDelayMs: delivery.baseDelayMs ?? DEFAULT_CARRY_OVER.baseDelayMs,
    maxDelayMs: delivery.maxDelayMs ?? DEFAULT_CARRY_OVER.maxDelayMs,
    random: delivery.random ?? Math.random,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function toReportBody(req: ReportMetricsBatchRequest): unknown {
  return {
    service: req.service,
    timestamp: req.timestamp,
    metrics: req.metrics.map((metric) => {
      if (metric.type === 'histogram') {
        return {
          metrics_type: metric.type,
          name: metric.name,
          labels: metric.labels,
          count: metric.count,
          sum: metric.sum,
          buckets: metric.buckets,
          updated_at: metric.updatedAt,
        };
      }

      return {
        metrics_type: metric.type,
        name: metric.name,
        labels: metric.labels,
        value: metric.value,
        updated_at: metric.updatedAt,
      };
    }),
  };
}
