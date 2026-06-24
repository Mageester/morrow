---
name: performance-profile
version: 1.0.0
description: Performance optimization workflow — profile the code, identify bottlenecks, propose and benchmark targeted fixes with before/after metrics
riskClass: medium
publisher: Axiom
---

# Performance Profile Skill

## Overview
This skill provides a data-driven performance optimization workflow. It emphasizes measurement over intuition: profile the code to find actual bottlenecks, form hypotheses based on data, apply targeted fixes, and benchmark rigorously to prove improvement. Never optimize without measuring first.

## When to Use
- A user reports slow response times or timeouts
- A service is hitting CPU, memory, or latency limits under load
- You are optimizing a hot code path before scaling horizontally
- A code review flags a potential performance issue (N+1 queries, unbounded loops)
- Capacity planning requires understanding performance characteristics

## Step-by-Step Instructions

### Phase 1: Establish Baselines
1. **Define the performance target.** What is "fast enough"? P95 latency under 200ms? 1000 requests per second? Be specific and measurable.
2. **Set up a reproducible benchmark.** Use a benchmarking tool (wrk, k6, ab, pytest-benchmark) with realistic payloads. Run it multiple times and record the median and P95.
3. **Capture resource metrics.** Record CPU utilization, memory usage, garbage collection pauses, and I/O wait during the benchmark. Use `top`, `htop`, or APM tools.
4. **Document the environment.** Note the machine specs, database version, network conditions, and data volume. Benchmarks without context are meaningless.

### Phase 2: Profile to Find Bottlenecks
5. **Choose the right profiler.** CPU-bound: sampling profiler (py-spy, pprof, perf). Memory-bound: heap profiler. I/O-bound: tracing profiler (Jaeger, Zipkin). Database: query analyzer (EXPLAIN ANALYZE).
6. **Run the profiler during the benchmark.** Attach the profiler to the running process while the benchmark executes. Capture at least 30 seconds of data.
7. **Read the flame graph or call tree.** Identify the functions consuming the most CPU time (look for wide bars in the flame graph) or allocating the most memory.
8. **Identify the bottleneck type.** Is it CPU (expensive computation), memory (excessive allocation/GC), I/O (waiting on database/network), or lock contention (threads waiting on mutex)? The fix strategy depends on the type.

### Phase 3: Form and Test Hypotheses
9. **Formulate a specific hypothesis.** "The `serializeResponse` function takes 40% of CPU time because it JSON-stringifies a large object on every request. Caching the serialized output should reduce P95 latency by 30%."
10. **Apply the minimal optimization.** Make one change: add a cache, add a database index, batch queries, use a more efficient algorithm, add connection pooling.
11. **Re-run the SAME benchmark.** Compare before and after metrics. Use the exact same payloads, concurrency, and environment.
12. **Evaluate the result.** Did it meet the hypothesis? If the improvement is negligible, revert the change and form a new hypothesis. Not all optimizations work.

### Phase 4: Harden and Monitor
13. **Add performance tests to CI.** Prevent regressions by failing the build if latency exceeds a threshold.
14. **Add instrumentation.** Emit metrics (latency histograms, throughput counters) to your monitoring system. Set alerts for P95 latency exceeding the SLO.
15. **Document the optimization.** Record what was changed, why, and the before/after metrics. This helps future developers understand the performance model.

## Common Pitfalls
- **Optimizing without profiling.** Your intuition about what is slow is often wrong. Always profile first. Premature optimization wastes time and adds complexity.
- **Micro-benchmarking in isolation.** A function might be fast in a benchmark but slow in production due to contention, cold caches, or different data shapes. Always benchmark in realistic conditions.
- **Optimizing the wrong thing.** Reducing a function from 1ms to 0.1ms is pointless if the function is only called once per request and the database query takes 200ms. Focus on the biggest consumers.
- **Not controlling variables.** If you change the code AND the database index AND the cache config, you don't know which change helped. Change one thing at a time.
- **Ignoring tail latency.** P50 is the easy number. P95 and P99 are what users actually experience. A handful of slow requests ruin the perception of performance.

## Verification Checklist
- [ ] Performance target defined (specific metric + threshold)
- [ ] Reproducible benchmark established with realistic payloads
- [ ] Baseline metrics captured (median, P95, CPU, memory)
- [ ] Profiler run during benchmark, flame graph captured
- [ ] Bottleneck identified (specific function or query)
- [ ] Hypothesis formulated with predicted improvement
- [ ] Single optimization applied
- [ ] Benchmark re-run — before/after comparison documented
- [ ] Improvement meets the target; if not, revert and retry
- [ ] Performance tests added to CI with thresholds
- [ ] Monitoring alerts configured for latency SLO
