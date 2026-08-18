import test from "node:test";
import assert from "node:assert/strict";
import {
  databaseIdentity, isDisposableName, sameDatabase, validateDisposableDatabase,
} from "../scripts/test-db-guard.mjs";

const allow = "1";

test("only postgres and postgresql urls are accepted", () => {
  assert.equal(databaseIdentity("postgres://user@127.0.0.1:5432/comment_to_dm_test")?.name, "comment_to_dm_test");
  assert.equal(databaseIdentity("postgresql://user@127.0.0.1:5432/comment_to_dm_test")?.name, "comment_to_dm_test");
  assert.equal(databaseIdentity("mysql://user@127.0.0.1:3306/comment_to_dm_test"), null);
  assert.equal(databaseIdentity("http://127.0.0.1/comment_to_dm_test"), null);
  assert.equal(databaseIdentity("postgres://user@127.0.0.1:5432/"), null);
  assert.equal(databaseIdentity(""), null);
});

test("test and integration must be separate name segments", () => {
  assert.equal(isDisposableName("comment_to_dm_test"), true);
  assert.equal(isDisposableName("comment-to-dm-integration"), true);
  assert.equal(isDisposableName("test"), true);
  assert.equal(isDisposableName("latest"), false, "latest must not be mistaken for a test database");
  assert.equal(isDisposableName("greatest_hits"), false);
  assert.equal(isDisposableName("integrationdb"), false);
  assert.equal(isDisposableName("commentdm"), false);
});

test("database identity ignores protocol, host case, default port and query", () => {
  const app = databaseIdentity("postgresql://user:pw@DB.internal:5432/comment_to_dm_test?sslmode=require");
  const test1 = databaseIdentity("postgres://user@db.internal/comment_to_dm_test");
  assert.equal(sameDatabase(app, test1), true);
  const other = databaseIdentity("postgres://user@db.internal:5433/comment_to_dm_test");
  assert.equal(sameDatabase(app, other), false);
  const otherName = databaseIdentity("postgres://user@db.internal/comment_to_dm_test_2");
  assert.equal(sameDatabase(app, otherName), false);
});

test("a disposable database passes every check", () => {
  const result = validateDisposableDatabase({
    url: "postgres://user@127.0.0.1:5432/comment_to_dm_test",
    allowFlag: allow,
    appUrl: "postgres://user@127.0.0.1:5432/commentdm",
  });
  assert.equal(result.ok, true);
  assert.equal(result.identity.name, "comment_to_dm_test");
});

test("the app database is rejected even when spelled differently", () => {
  const result = validateDisposableDatabase({
    url: "postgres://user@127.0.0.1/comment_to_dm_test",
    allowFlag: allow,
    appUrl: "postgresql://user:pw@127.0.0.1:5432/comment_to_dm_test?sslmode=require&application_name=app",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "same_as_app");
});

test("missing url, missing confirmation and unsafe names are refused", () => {
  assert.equal(validateDisposableDatabase({ url: "", allowFlag: allow }).code, "missing_url");
  assert.equal(validateDisposableDatabase({
    url: "postgres://user@127.0.0.1:5432/comment_to_dm_test", allowFlag: undefined,
  }).code, "missing_flag");
  assert.equal(validateDisposableDatabase({
    url: "postgres://user@127.0.0.1:5432/latest", allowFlag: allow,
  }).code, "unsafe_name");
  assert.equal(validateDisposableDatabase({
    url: "mysql://user@127.0.0.1:3306/comment_to_dm_test", allowFlag: allow,
  }).code, "invalid_url");
});
