import assert from "node:assert/strict";
import test from "node:test";

import { readNullablePgBoolean, readPgBoolean } from "../app/db/row-value-readers";

test("readPgBoolean handles PostgreSQL boolean strings", () => {
  assert.equal(readPgBoolean("t"), true);
  assert.equal(readPgBoolean("f"), false);
  assert.equal(readPgBoolean("true"), true);
  assert.equal(readPgBoolean("false"), false);
});

test("readPgBoolean does not treat non-empty false strings as true", () => {
  assert.equal(readPgBoolean("0"), false);
  assert.throws(() => readPgBoolean("not-a-bool"), /Expected PostgreSQL boolean/);
});

test("readNullablePgBoolean preserves nulls", () => {
  assert.equal(readNullablePgBoolean(null), null);
  assert.equal(readNullablePgBoolean(undefined), null);
});
