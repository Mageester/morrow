import Database from "better-sqlite3";

const database = new Database(":memory:");
try {
  database.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  database.prepare("INSERT INTO smoke (value) VALUES (?)").run("ok");
  const row = database.prepare("SELECT value FROM smoke WHERE id = 1").get() as { value: string } | undefined;
  if (row?.value !== "ok") throw new Error("SQLite readback failed");
  console.log("SQLite smoke test passed.");
} finally {
  database.close();
}
