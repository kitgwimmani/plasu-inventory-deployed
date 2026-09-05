// db/reset.js
// Wipes ALL data from the database. By default leaves only a single Super Admin
// account (superadmin@plasu.edu.ng / Passw0rd!) — no other users, departments,
// categories or items — so real data entry starts from a true blank slate.
//
//   node db/reset.js --yes            (superadmin only — default, no prompt)
//   node db/reset.js --yes --demo     (also re-seeds demo users/categories/
//                                       departments/sample items, as before)
//   node db/reset.js                  (asks for confirmation first)
//
// Stop the API (pm2 stop plasu-smis) before running this against the live
// database — a second process writing to the same SQLite file at once can
// error with "database is locked".
const readline = require("readline");
const { db, seedDemoData, seedSuperadminOnly, backfillUserRoles } = require("./init");

// Child-before-parent so foreign keys stay satisfied (we also disable FKs to be safe).
const TABLES = [
  "clearance_signoffs",
  "clearance_requests",
  "signoffs",
  "requisition_items",
  "requisitions",
  "stock_receipts",
  "item_packagings",
  "items",
  "subcategories",
  "categories",
  "notifications",
  "audit_logs",
  "user_roles",
  "users",
  "departments",
];

function wipeAndSeed(demo) {
  db.exec("PRAGMA foreign_keys=OFF");
  const tx = db.transaction(() => {
    for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
    db.exec("DELETE FROM sqlite_sequence");
  });
  tx();
  db.exec("PRAGMA foreign_keys=ON");

  if (demo) {
    // seedDemoData() re-creates the 8 demo users, categories, departments and
    // sample items now that every table is empty; backfillUserRoles() fills
    // user_roles from each seeded user's primary role.
    seedDemoData();
    backfillUserRoles();
  } else {
    seedSuperadminOnly();
  }

  const counts = {
    users: db.prepare("SELECT COUNT(*) AS c FROM users").get().c,
    departments: db.prepare("SELECT COUNT(*) AS c FROM departments").get().c,
    categories: db.prepare("SELECT COUNT(*) AS c FROM categories").get().c,
    items: db.prepare("SELECT COUNT(*) AS c FROM items").get().c,
  };
  console.log("Database reset complete:", counts);
  if (!demo) {
    console.log("Log in as superadmin@plasu.edu.ng (password: Passw0rd!) to create departments, categories and other users.");
  }
}

const demo = process.argv.includes("--demo");

if (process.argv.includes("--yes") || process.argv.includes("-y")) {
  wipeAndSeed(demo);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const mode = demo ? "demo data" : "a single Super Admin account only";
  rl.question(
    `This DELETES ALL DATA (users, requisitions, inventory, clearances, audit log) and leaves ${mode}.\nType "RESET" to continue: `,
    (answer) => {
      rl.close();
      if (answer.trim() === "RESET") {
        wipeAndSeed(demo);
      } else {
        console.log("Aborted — nothing changed.");
        process.exit(1);
      }
    }
  );
}
