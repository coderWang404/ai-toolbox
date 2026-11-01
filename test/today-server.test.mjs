import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTodayServer } from "../src/today/server.mjs";

test("createTodayServer requires a client", () => {
  assert.throws(() => createTodayServer({}), /需要 client/);
});
