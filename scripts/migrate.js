const { closeDatabase, migrateDatabase } = require("../src/server/database");

migrateDatabase()
  .then(async () => {
    console.log("Database migrations completed.");
    await closeDatabase();
  })
  .catch(async (error) => {
    console.error(error.message || error);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
