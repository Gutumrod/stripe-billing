// LR2FA-WU-D2 — raw classifier evidence runner (STAGE D2 repair).
//
// Purpose: print, for every code named in the work unit's acceptance checks, exactly what
// platform/runtime/dist/db.js:classifyDependencyFailure does with it — status, retryable, and
// whether the original error was re-thrown unchanged. This file is an EVIDENCE runner, not a
// test: it is deliberately named without `.test.mjs` so `node --test tests/*.test.mjs` does not
// collect it and the suite's pass/fail totals are unaffected.
//
// Run: node tests/sqlstate-classifier-evidence.mjs   (after `npm run build`)
//
// No secret-shaped value appears here: every code below is a non-secret protocol/driver literal,
// and no connection string, host, port or credential is used or printed.

import { classifyDependencyFailure, BillingDependencyError } from '../dist/index.js';

// Expectation column is declared, then observed, then compared — so this runner can fail.
const DEPENDENCY_CODES = [
  '57P03', // cannot_connect_now          (class 57, alphanumeric subclass) — the D1 defect
  '57P01', // admin_shutdown              (class 57, alphanumeric subclass) — the D1 defect
  '08P01', // protocol_violation          (class 08, alphanumeric subclass) — the D1 defect
  '53300', // too_many_connections        (class 53, all-digit — previously working)
  '57000', // operator_intervention       (class 57, all-digit — previously working)
  '08000', // connection_exception        (class 08, all-digit — previously working)
  '58P01', // undefined_file              (class 58, alphanumeric subclass)
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'CONNECTION_DESTROYED',
];

const NON_DEPENDENCY_CODES = [
  '42P01',      // undefined_table   — OUR OWN query/schema is wrong: must NOT be relabelled
  'not_a_sqlstate', // bare lowercase word, not SQLSTATE-shaped: must NOT be classified
  '57P0',       // wrong length: must NOT be classified
  '5',          // wrong length
  '',           // empty
  '08p01',      // lowercase subclass: not the PostgreSQL SQLSTATE alphabet
];

function observe(code) {
  const error = { code, name: 'ProbeError' };
  try {
    classifyDependencyFailure('d2-evidence', error);
    return { outcome: 'RETURNED_WITHOUT_THROWING', status: null, retryable: null, rethrown: false, sameObject: false };
  } catch (thrown) {
    if (thrown === error) {
      return { outcome: 'RE_THROWN_UNCHANGED', status: null, retryable: null, rethrown: true, sameObject: true };
    }
    return {
      outcome: thrown instanceof BillingDependencyError ? 'BillingDependencyError' : `${thrown?.constructor?.name ?? typeof thrown}`,
      status: thrown?.status ?? null,
      retryable: thrown?.retryable ?? null,
      code: thrown?.code ?? null,
      rethrown: false,
      sameObject: false,
    };
  }
}

let failures = 0;

console.log('--- classifyDependencyFailure: MUST classify as retryable dependency (503, retryable=true) ---');
for (const code of DEPENDENCY_CODES) {
  const observed = observe(code);
  const ok = observed.outcome === 'BillingDependencyError' && observed.status === 503 && observed.retryable === true;
  if (!ok) failures += 1;
  console.log(
    `${code.padEnd(20)} -> outcome=${observed.outcome} status=${observed.status} retryable=${observed.retryable} `
    + `internalCode=${observed.code} rethrown=${observed.rethrown} => ${ok ? 'OK' : 'MISMATCH'}`,
  );
}

console.log('--- classifyDependencyFailure: MUST NOT classify; original error re-thrown unchanged ---');
for (const code of NON_DEPENDENCY_CODES) {
  const observed = observe(code);
  const ok = observed.outcome === 'RE_THROWN_UNCHANGED' && observed.sameObject === true;
  if (!ok) failures += 1;
  console.log(
    `${JSON.stringify(code).padEnd(20)} -> outcome=${observed.outcome} status=${observed.status} retryable=${observed.retryable} `
    + `sameObjectRethrown=${observed.sameObject} => ${ok ? 'OK' : 'MISMATCH'}`,
  );
}

// The classifier's own message must never carry the code, a host, a port or a connection string.
const leak = observe('57P03');
const thrownError = (() => {
  try { classifyDependencyFailure('d2-evidence', { code: '57P03' }); return null; } catch (error) { return error; }
})();
const wire = JSON.stringify({ error: thrownError.code, message: thrownError.message, retryable: thrownError.retryable });
const leaksNothing = !/57P03|postgres:\/\/|127\.0\.0\.1|:\d{2,5}\//i.test(wire);
if (!leaksNothing) failures += 1;
console.log(`--- non-echo check --- ${leak.outcome} wire=${wire} leaksNothing=${leaksNothing} => ${leaksNothing ? 'OK' : 'MISMATCH'}`);

console.log(`TOTAL MISMATCHES: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
