/**
 * Integration- и migration-тесты выполняют TRUNCATE и DROP SCHEMA public.
 * Такой запуск допустим только на отдельной одноразовой базе, поэтому проверка требует
 * несколько независимых подтверждений и отдельно отказывает, если указана рабочая база.
 *
 * Валидация вынесена в чистые функции, чтобы её можно было проверять тестами без process.exit.
 */

const ALLOWED_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const DISPOSABLE_SEGMENTS = new Set(["test", "integration"]);

/** Нормализованная идентичность базы: протокол, регистр хоста, порт по умолчанию и query её не меняют. */
export function databaseIdentity(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  let name;
  try {
    name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
  if (!name) return null;
  return { host: url.hostname.toLowerCase(), port: url.port || "5432", name };
}

/** test и integration должны быть отдельным сегментом имени: latest не проходит. */
export function isDisposableName(name) {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((segment) => DISPOSABLE_SEGMENTS.has(segment));
}

export function sameDatabase(left, right) {
  if (!left || !right) return false;
  return left.host === right.host && left.port === right.port && left.name === right.name;
}

export function validateDisposableDatabase({ url, allowFlag, appUrl }) {
  if (!url) {
    return { ok: false, code: "missing_url", message: "переменная с адресом базы не задана. Тест удаляет данные и работает только на одноразовой базе." };
  }
  if (allowFlag !== "1") {
    return { ok: false, code: "missing_flag", message: "не задано ALLOW_DESTRUCTIVE_TEST_DB=1. Это подтверждение того, что базу можно очистить." };
  }
  const identity = databaseIdentity(url);
  if (!identity) {
    return { ok: false, code: "invalid_url", message: "нужен корректный адрес со схемой postgres:// или postgresql:// и именем базы." };
  }
  if (!isDisposableName(identity.name)) {
    return { ok: false, code: "unsafe_name", message: `имя базы «${identity.name}» не содержит отдельного сегмента test или integration. Создайте отдельную базу для тестов.` };
  }
  if (sameDatabase(identity, databaseIdentity(appUrl))) {
    return { ok: false, code: "same_as_app", message: "указанная база совпадает с DATABASE_URL приложения. Рабочую базу очищать нельзя." };
  }
  return { ok: true, identity };
}

export function requireDisposableDatabase({ variable, command }) {
  const url = process.env[variable];
  const result = validateDisposableDatabase({
    url,
    allowFlag: process.env.ALLOW_DESTRUCTIVE_TEST_DB,
    appUrl: process.env.DATABASE_URL,
  });
  if (result.ok) return { url, name: result.identity.name };

  const example = `  createdb comment_to_dm_test\n`
    + `  ALLOW_DESTRUCTIVE_TEST_DB=1 ${variable}=postgres://USER@127.0.0.1:5432/comment_to_dm_test ${command}`;
  const reason = result.code === "missing_url"
    ? `переменная ${variable} не задана. Тест удаляет данные и работает только на одноразовой базе.`
    : result.message;
  console.error(`\n${command} остановлен: ${reason}\n\nБезопасный запуск:\n${example}\n`);
  process.exit(1);
}
