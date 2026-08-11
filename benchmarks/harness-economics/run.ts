#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  parseBenchmarkRecords,
  renderBenchmarkSvg,
  summarizeBenchmarkRecords,
} from "./metrics.js";

function main(): void {
  const args = process.argv.slice(2);
  const inputPath = args.find((arg) => !arg.startsWith("--"));
  if (!inputPath) {
    throw new Error("Usage: run.ts <records.json> [--out report.svg] [--json]");
  }

  const absoluteInputPath = resolve(inputPath);
  const input = JSON.parse(readFileSync(absoluteInputPath, "utf8")) as unknown;
  const records = parseBenchmarkRecords(input);
  const summaries = summarizeBenchmarkRecords(records);
  const outFlagIndex = args.indexOf("--out");
  const outputPath = outFlagIndex >= 0 && args[outFlagIndex + 1]
    ? resolve(args[outFlagIndex + 1]!)
    : resolve(dirname(absoluteInputPath), "harness-economics.svg");
  const title = isRecord(input) && typeof input.title === "string" ? input.title : undefined;

  writeFileSync(outputPath, renderBenchmarkSvg(summaries, { title }), "utf8");
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ summaries, outputPath }, null, 2) + "\n");
    return;
  }

  console.log(`Rendered ${summaries.length} harness summaries from ${records.length} tasks.`);
  console.log(outputPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main();
