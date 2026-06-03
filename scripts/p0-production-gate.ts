#!/usr/bin/env tsx
import "./test-harness/config.js";
import { evaluateP0ProductionGate } from "../app/p0-production-gate";

const result = evaluateP0ProductionGate(process.env);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
