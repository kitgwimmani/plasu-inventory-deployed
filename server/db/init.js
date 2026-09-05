// db/init.js
// SQLite schema + seed data for PLASU Store Management Information System (SMIS)
//
// Uses Node's built-in `node:sqlite` module (bundled with Node 22.5+) instead of
// better-sqlite3, so there is NO native module to compile — no Visual Studio Build
// Tools on Windows, no Xcode Command Line Tools on Mac, no python/make on Linux.
// You may see an "ExperimentalWarning: SQLite is an experimental feature" message
// on startup — that is expected and harmless.
const path = require("path");
const bcrypt = require("bcryptjs");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "plasu_smis.sqlite");
const raw = new DatabaseSync(DB_PATH);
raw.exec("PRAGMA foreign_keys = ON");

// Thin wrapper so the rest of the codebase can keep using the familiar
// better-sqlite3-style API: db.exec(), db.prepare(sql).run/get/all(), db.transaction(fn).
const db = {
  exec(sql) {
    raw.exec(sql);
    return db;
  },
  prepare(sql) {
    const stmt = raw.prepare(sql);
    return {
      run: (...params) => {
        const info = stmt.run(...params);
        return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
      },
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params),
    };
  },
  transaction(fn) {
    return (...args) => {
      raw.exec("BEGIN");
      try {
        const result = fn(...args);
        raw.exec("COMMIT");
        return result;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    };
  },
};

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------
// A user can now hold SEVERAL roles at once (stored in the user_roles table).
// `users.role` is kept as the single "primary" role — derived from ROLE_PRIORITY
// — and drives dashboard routing, display and the code-sequence helpers.
const ROLES = [
  "superadmin",
  "ictadmin",
  "hod",
  "head_of_store",
  "issuance_officer",
  "technical_expert",
  "audit_officer",
  "asset_officer",
];
const ROLE_CHECK_SQL = `CHECK(role IN ('superadmin','ictadmin','hod','head_of_store','issuance_officer','technical_expert','audit_officer','asset_officer'))`;

// Requisition clearance signatories, in signing order: the Head of Store signs
// first, then the Issuance Officer.
const SIGNOFF_ROLES = ["head_of_store", "issuance_officer"];
// Stock-receipt clearance signatories — the only workflow action these three
// roles perform (besides viewing/printing inventory).
const CLEARANCE_ROLES = ["technical_expert", "audit_officer", "asset_officer"];
// Roles that manage master data (categories, subcategories, items) and receive
// back-office notifications (low stock, new submissions, etc).
const BACKOFFICE_ROLES = ["superadmin", "ictadmin", "head_of_store"];
// Highest-privilege-first ordering used to pick a user's primary role.
const ROLE_PRIORITY = [
  "superadmin",
  "ictadmin",
  "head_of_store",
  "issuance_officer",
  "hod",
  "technical_expert",
  "audit_officer",
  "asset_officer",
];

function primaryRole(roles) {
  const list = Array.isArray(roles) ? roles : [roles];
  for (const r of ROLE_PRIORITY) {
    if (list.includes(r)) return r;
  }
  return list[0] || "hod";
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Small schema-migration helpers: SQLite lets us ADD COLUMN freely (as long as
// it doesn't need to be NOT NULL without a default), so most upgrades to an
// existing installation can be applied in-place without rebuilding tables.
// For the changes SQLite can't do in place (altering a CHECK constraint,
// dropping NOT NULL) rebuildTable() follows SQLite's recommended
// create-new / copy / drop-old / rename procedure.
// ---------------------------------------------------------------------------
function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}
function ensureColumn(table, column, ddl) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
function tableSql(name) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row ? row.sql : null;
}
function tableExists(name) {
  return !!tableSql(name);
}

// Rebuild `name` with a fresh column definition. `columnsDdl` is the text that
// goes between the parentheses of CREATE TABLE. By default the intersecting
// columns are copied across from the old table.
function rebuildTable(name, columnsDdl, { copyData = true, selectExpr = {} } = {}) {
  raw.exec("PRAGMA foreign_keys=OFF");
  raw.exec("BEGIN");
  try {
    raw.exec(`CREATE TABLE __new_${name} (${columnsDdl})`);
    if (copyData) {
      const newCols = db.prepare(`PRAGMA table_info(__new_${name})`).all().map((c) => c.name);
      const oldCols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
      const shared = newCols.filter((c) => oldCols.includes(c));
      if (shared.length) {
        const selectList = shared.map((c) => (selectExpr[c] ? `${selectExpr[c]} AS ${c}` : c));
        raw.exec(
          `INSERT INTO __new_${name} (${shared.join(",")}) SELECT ${selectList.join(",")} FROM ${name}`
        );
      }
    }
    raw.exec(`DROP TABLE ${name}`);
    raw.exec(`ALTER TABLE __new_${name} RENAME TO ${name}`);
    raw.exec("COMMIT");
  } catch (err) {
    raw.exec("ROLLBACK");
    raw.exec("PRAGMA foreign_keys=ON");
    throw err;
  }
  raw.exec("PRAGMA foreign_keys=ON");
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      code TEXT UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS subcategories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      UNIQUE(category_id, name),
      FOREIGN KEY(category_id) REFERENCES categories(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL ${ROLE_CHECK_SQL},
      department TEXT,
      department_id INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      updated_by INTEGER,
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(department_id) REFERENCES departments(id)
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL ${ROLE_CHECK_SQL},
      created_at TEXT NOT NULL,
      UNIQUE(user_id, role),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      unit TEXT NOT NULL DEFAULT 'ea',
      quantity_on_hand REAL NOT NULL DEFAULT 0,
      reorder_level REAL NOT NULL DEFAULT 0,
      category_id INTEGER,
      subcategory_id INTEGER,
      department_id INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      updated_by INTEGER,
      FOREIGN KEY(category_id) REFERENCES categories(id),
      FOREIGN KEY(subcategory_id) REFERENCES subcategories(id),
      FOREIGN KEY(department_id) REFERENCES departments(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS item_packagings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      units_per_pack REAL NOT NULL CHECK(units_per_pack > 0),
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY(item_id) REFERENCES items(id)
    );

    CREATE TABLE IF NOT EXISTS stock_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      qty REAL NOT NULL CHECK(qty > 0),
      packaging_id INTEGER,
      pack_qty REAL,
      remarks TEXT,
      received_by INTEGER NOT NULL,
      clearance_request_id INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(item_id) REFERENCES items(id),
      FOREIGN KEY(received_by) REFERENCES users(id),
      FOREIGN KEY(clearance_request_id) REFERENCES clearance_requests(id)
    );

    CREATE TABLE IF NOT EXISTS requisitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_no TEXT NOT NULL UNIQUE,
      hod_id INTEGER NOT NULL,
      department TEXT NOT NULL,
      department_id INTEGER,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','recommended','approved','rejected','issued')),
      created_at TEXT NOT NULL,
      recommended_by INTEGER,
      recommended_at TEXT,
      recommendation_remark TEXT,
      accepted_at TEXT,
      approved_by INTEGER,
      approved_at TEXT,
      rejected_by INTEGER,
      rejected_at TEXT,
      rejection_reason TEXT,
      issued_by INTEGER,
      issued_at TEXT,
      FOREIGN KEY(hod_id) REFERENCES users(id),
      FOREIGN KEY(department_id) REFERENCES departments(id),
      FOREIGN KEY(recommended_by) REFERENCES users(id),
      FOREIGN KEY(approved_by) REFERENCES users(id),
      FOREIGN KEY(rejected_by) REFERENCES users(id),
      FOREIGN KEY(issued_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS requisition_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requisition_id INTEGER NOT NULL,
      item_id INTEGER,
      qty_requested REAL NOT NULL CHECK(qty_requested > 0),
      qty_recommended REAL,
      remarks TEXT,
      packaging_id INTEGER,
      pack_qty REAL,
      is_adhoc INTEGER NOT NULL DEFAULT 0,
      adhoc_name TEXT,
      adhoc_description TEXT,
      adhoc_unit TEXT,
      adhoc_category_id INTEGER,
      adhoc_subcategory_id INTEGER,
      adhoc_department_id INTEGER,
      FOREIGN KEY(requisition_id) REFERENCES requisitions(id),
      FOREIGN KEY(item_id) REFERENCES items(id),
      FOREIGN KEY(packaging_id) REFERENCES item_packagings(id),
      FOREIGN KEY(adhoc_category_id) REFERENCES categories(id),
      FOREIGN KEY(adhoc_subcategory_id) REFERENCES subcategories(id),
      FOREIGN KEY(adhoc_department_id) REFERENCES departments(id)
    );

    CREATE TABLE IF NOT EXISTS signoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requisition_id INTEGER NOT NULL,
      role_label TEXT NOT NULL CHECK(role_label IN ('head_of_store','issuance_officer')),
      signed INTEGER NOT NULL DEFAULT 0,
      signed_by_name TEXT,
      signed_at TEXT,
      UNIQUE(requisition_id, role_label),
      FOREIGN KEY(requisition_id) REFERENCES requisitions(id)
    );

    CREATE TABLE IF NOT EXISTS clearance_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_no TEXT NOT NULL UNIQUE,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','cleared')),
      remark TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      cleared_at TEXT,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS clearance_signoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clearance_request_id INTEGER NOT NULL,
      role_label TEXT NOT NULL CHECK(role_label IN ('technical_expert','audit_officer','asset_officer')),
      signed INTEGER NOT NULL DEFAULT 0,
      signed_by_name TEXT,
      signed_at TEXT,
      remark TEXT,
      UNIQUE(clearance_request_id, role_label),
      FOREIGN KEY(clearance_request_id) REFERENCES clearance_requests(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      actor_email TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(actor_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);

  // ---- Additive in-place upgrades for older installs ----
  ensureColumn("items", "category_id", "category_id INTEGER REFERENCES categories(id)");
  ensureColumn("items", "subcategory_id", "subcategory_id INTEGER REFERENCES subcategories(id)");
  ensureColumn("items", "department_id", "department_id INTEGER REFERENCES departments(id)");
  ensureColumn("items", "updated_at", "updated_at TEXT");
  ensureColumn("items", "updated_by", "updated_by INTEGER REFERENCES users(id)");

  ensureColumn("users", "department_id", "department_id INTEGER REFERENCES departments(id)");
  ensureColumn("users", "updated_at", "updated_at TEXT");
  ensureColumn("users", "updated_by", "updated_by INTEGER REFERENCES users(id)");

  ensureColumn("requisitions", "department_id", "department_id INTEGER REFERENCES departments(id)");
  ensureColumn("requisition_items", "packaging_id", "packaging_id INTEGER REFERENCES item_packagings(id)");
  ensureColumn("requisition_items", "pack_qty", "pack_qty REAL");
  ensureColumn("stock_receipts", "packaging_id", "packaging_id INTEGER REFERENCES item_packagings(id)");
  ensureColumn("stock_receipts", "pack_qty", "pack_qty REAL");
  ensureColumn("stock_receipts", "clearance_request_id", "clearance_request_id INTEGER REFERENCES clearance_requests(id)");

  db.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_items_subcategory ON items(subcategory_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_requisitions_dept ON requisitions(department_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_receipts_clearance ON stock_receipts(clearance_request_id);`);
}

// ---------------------------------------------------------------------------
// Migrations for installs created before the role/workflow overhaul.
// ---------------------------------------------------------------------------
function backfillUserRoles() {
  const missing = db
    .prepare(
      `SELECT u.id, u.role FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)`
    )
    .all();
  const ins = db.prepare(
    "INSERT OR IGNORE INTO user_roles(user_id, role, created_at) VALUES (?,?,?)"
  );
  for (const u of missing) ins.run(u.id, u.role, nowIso());
}

function migrateSchema() {
  // 1. users: widen the role CHECK to the new role set and rename the legacy
  //    "inventoryadmin" role to "head_of_store".
  const usersSql = tableSql("users");
  if (usersSql && !usersSql.includes("head_of_store")) {
    console.log("Migrating users table for the Head of Store / multi-role model...");
    rebuildTable(
      "users",
      `id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       email TEXT NOT NULL UNIQUE,
       password_hash TEXT NOT NULL,
       role TEXT NOT NULL ${ROLE_CHECK_SQL},
       department TEXT,
       department_id INTEGER REFERENCES departments(id),
       is_active INTEGER NOT NULL DEFAULT 1,
       created_by INTEGER REFERENCES users(id),
       created_at TEXT NOT NULL,
       updated_at TEXT,
       updated_by INTEGER REFERENCES users(id)`,
      { selectExpr: { role: "CASE WHEN role='inventoryadmin' THEN 'head_of_store' ELSE role END" } }
    );
  }

  // 2. user_roles: backfill from users.role, then rename legacy role values.
  if (tableExists("user_roles")) {
    backfillUserRoles();
    try {
      db.exec("UPDATE user_roles SET role='head_of_store' WHERE role='inventoryadmin'");
    } catch (err) {
      /* CHECK on a rebuilt table already rejects the legacy value — nothing to do */
    }
  }

  // 3. requisitions: add the 'recommended' status + recommendation columns.
  const reqSql = tableSql("requisitions");
  if (reqSql && !reqSql.includes("'recommended'")) {
    console.log("Migrating requisitions table for the recommend/accept workflow...");
    rebuildTable(
      "requisitions",
      `id INTEGER PRIMARY KEY AUTOINCREMENT,
       req_no TEXT NOT NULL UNIQUE,
       hod_id INTEGER NOT NULL REFERENCES users(id),
       department TEXT NOT NULL,
       department_id INTEGER REFERENCES departments(id),
       purpose TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending'
         CHECK(status IN ('pending','recommended','approved','rejected','issued')),
       created_at TEXT NOT NULL,
       recommended_by INTEGER REFERENCES users(id),
       recommended_at TEXT,
       recommendation_remark TEXT,
       accepted_at TEXT,
       approved_by INTEGER REFERENCES users(id),
       approved_at TEXT,
       rejected_by INTEGER REFERENCES users(id),
       rejected_at TEXT,
       rejection_reason TEXT,
       issued_by INTEGER REFERENCES users(id),
       issued_at TEXT`
    );
  }

  // 4. requisition_items: make item_id nullable + add adhoc / recommended cols.
  if (tableExists("requisition_items") && !columnExists("requisition_items", "is_adhoc")) {
    console.log("Migrating requisition_items table for ad-hoc (new) item requests...");
    rebuildTable(
      "requisition_items",
      `id INTEGER PRIMARY KEY AUTOINCREMENT,
       requisition_id INTEGER NOT NULL REFERENCES requisitions(id),
       item_id INTEGER REFERENCES items(id),
       qty_requested REAL NOT NULL CHECK(qty_requested > 0),
       qty_recommended REAL,
       remarks TEXT,
       packaging_id INTEGER REFERENCES item_packagings(id),
       pack_qty REAL,
       is_adhoc INTEGER NOT NULL DEFAULT 0,
       adhoc_name TEXT,
       adhoc_description TEXT,
       adhoc_unit TEXT,
       adhoc_category_id INTEGER REFERENCES categories(id),
       adhoc_subcategory_id INTEGER REFERENCES subcategories(id),
       adhoc_department_id INTEGER REFERENCES departments(id)`
    );
  }

  // 5. signoffs: the clearance sheet is now just Head of Store + Issuance Officer.
  //    Legacy rows (requester/technical/audit/asset) can't satisfy the new CHECK,
  //    so drop them and re-seed empty slots for any still-open approved requisition.
  const signoffSql = tableSql("signoffs");
  if (signoffSql && signoffSql.includes("'requester'")) {
    console.log("Migrating signoffs table to the 2-party requisition clearance...");
    rebuildTable(
      "signoffs",
      `id INTEGER PRIMARY KEY AUTOINCREMENT,
       requisition_id INTEGER NOT NULL REFERENCES requisitions(id),
       role_label TEXT NOT NULL CHECK(role_label IN ('head_of_store','issuance_officer')),
       signed INTEGER NOT NULL DEFAULT 0,
       signed_by_name TEXT,
       signed_at TEXT,
       UNIQUE(requisition_id, role_label)`,
      { copyData: false }
    );
    const openApproved = db.prepare("SELECT id FROM requisitions WHERE status='approved'").all();
    const insSlot = db.prepare(
      "INSERT OR IGNORE INTO signoffs(requisition_id, role_label, signed) VALUES (?,?,0)"
    );
    for (const r of openApproved) {
      for (const label of SIGNOFF_ROLES) insSlot.run(r.id, label);
    }
  }
}

// ---------------------------------------------------------------------------
// Sequence helpers
// ---------------------------------------------------------------------------
function nextReqNo() {
  const year = new Date().getFullYear();
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM requisitions WHERE req_no LIKE ?`)
    .get(`PLASU-SRV-${year}-%`);
  const next = (row.c || 0) + 1;
  return `PLASU-SRV-${year}-${String(next).padStart(4, "0")}`;
}

function nextClearanceRef() {
  const year = new Date().getFullYear();
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM clearance_requests WHERE ref_no LIKE ?`)
    .get(`PLASU-CLR-${year}-%`);
  const next = (row.c || 0) + 1;
  return `PLASU-CLR-${year}-${String(next).padStart(4, "0")}`;
}

// Item IDs are always system-generated, never typed in by a user. The prefix
// comes from the item's category (e.g. "STA" for Stationery) so codes stay
// human-scannable on printed reports: STA-0001, STA-0002, FUR-0001, ...
function nextItemCode(categoryId) {
  const cat = categoryId ? db.prepare("SELECT code FROM categories WHERE id = ?").get(categoryId) : null;
  const prefix = (cat && cat.code) ? cat.code : "GEN";
  const row = db.prepare(`SELECT COUNT(*) AS c FROM items WHERE code LIKE ?`).get(`${prefix}-%`);
  const next = (row.c || 0) + 1;
  return `${prefix}-${String(next).padStart(4, "0")}`;
}

function nextDeptCode(name) {
  const base = String(name || "DEPT")
    .replace(/[^a-zA-Z ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 5) || "DEPT";
  let candidate = base;
  let i = 1;
  while (db.prepare("SELECT id FROM departments WHERE code = ?").get(candidate)) {
    i += 1;
    candidate = `${base}${i}`;
  }
  return candidate;
}

function nextCategoryCode(name) {
  const base = String(name || "GEN")
    .replace(/[^a-zA-Z]/g, "")
    .slice(0, 3)
    .toUpperCase() || "GEN";
  let candidate = base;
  let i = 1;
  while (db.prepare("SELECT id FROM categories WHERE code = ?").get(candidate)) {
    i += 1;
    candidate = `${base}${i}`;
  }
  return candidate;
}

// Subcategory codes are namespaced under their category prefix, e.g. "STA-PEN".
function nextSubcategoryCode(categoryId, name) {
  const cat = categoryId ? db.prepare("SELECT code FROM categories WHERE id = ?").get(categoryId) : null;
  const prefix = (cat && cat.code) ? cat.code : "GEN";
  const base = String(name || "SUB")
    .replace(/[^a-zA-Z]/g, "")
    .slice(0, 3)
    .toUpperCase() || "SUB";
  let candidate = `${prefix}-${base}`;
  let i = 1;
  while (db.prepare("SELECT id FROM subcategories WHERE code = ?").get(candidate)) {
    i += 1;
    candidate = `${prefix}-${base}${i}`;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// User-role helpers
// ---------------------------------------------------------------------------
function rolesForUser(userId) {
  return db
    .prepare("SELECT role FROM user_roles WHERE user_id = ? ORDER BY id")
    .all(userId)
    .map((r) => r.role);
}

// Replace a user's full role set and recompute their primary `users.role`.
function setUserRoles(userId, roles) {
  const clean = [...new Set((roles || []).filter((r) => ROLES.includes(r)))];
  if (clean.length === 0) throw new Error("A user must have at least one role.");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(userId);
    const ins = db.prepare("INSERT INTO user_roles(user_id, role, created_at) VALUES (?,?,?)");
    for (const r of clean) ins.run(userId, r, nowIso());
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(primaryRole(clean), userId);
  });
  tx();
  return clean;
}

function audit(actorId, actorEmail, action, entityType, entityId, details) {
  db.prepare(
    `INSERT INTO audit_logs(actor_id, actor_email, action, entity_type, entity_id, details, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(actorId || null, actorEmail || null, action, entityType, entityId || null, JSON.stringify(details || {}), nowIso());
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
function notifyUsers(userIds, { type, title, message, entity_type, entity_id }) {
  const uniqueIds = [...new Set((userIds || []).filter(Boolean))];
  if (uniqueIds.length === 0) return;
  const ts = nowIso();
  const stmt = db.prepare(
    `INSERT INTO notifications(user_id, type, title, message, entity_type, entity_id, is_read, created_at)
     VALUES (?,?,?,?,?,?,0,?)`
  );
  for (const uid of uniqueIds) {
    stmt.run(uid, type, title, message || "", entity_type || null, entity_id || null, ts);
  }
}

function notifyRoles(roles, payload) {
  const roleList = Array.isArray(roles) ? roles : [roles];
  const placeholders = roleList.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       WHERE ur.role IN (${placeholders}) AND u.is_active = 1`
    )
    .all(...roleList);
  notifyUsers(rows.map((r) => r.id), payload);
}

function notifyUser(userId, payload) {
  notifyUsers([userId], payload);
}

function checkLowStockAndNotify(itemId) {
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(itemId);
  if (!item || !item.is_active) return;
  if (item.quantity_on_hand <= item.reorder_level) {
    notifyRoles(BACKOFFICE_ROLES, {
      type: "low_stock",
      title: `Low stock: ${item.name}`,
      message: `${item.name} (${item.code}) is at ${item.quantity_on_hand} ${item.unit}, at or below the reorder level of ${item.reorder_level}.`,
      entity_type: "ITEM",
      entity_id: item.id,
    });
  }
}

// Backfills department_id on users/requisitions from the legacy free-text
// `department` column, creating department master records as needed.
function migrateDepartmentsFromText() {
  const distinctUserDepts = db
    .prepare("SELECT DISTINCT department FROM users WHERE department IS NOT NULL AND TRIM(department) != '' AND department_id IS NULL")
    .all();
  const distinctReqDepts = db
    .prepare("SELECT DISTINCT department FROM requisitions WHERE department IS NOT NULL AND TRIM(department) != '' AND department_id IS NULL")
    .all();
  const names = new Set([...distinctUserDepts, ...distinctReqDepts].map((r) => r.department.trim()));
  for (const name of names) {
    let dept = db.prepare("SELECT * FROM departments WHERE name = ?").get(name);
    if (!dept) {
      const code = nextDeptCode(name);
      const info = db
        .prepare(`INSERT INTO departments(name, code, is_active, created_at) VALUES (?,?,1,?)`)
        .run(name, code, nowIso());
      dept = { id: info.lastInsertRowid, name, code };
    }
    db.prepare("UPDATE users SET department_id = ? WHERE department = ? AND department_id IS NULL").run(dept.id, name);
    db.prepare("UPDATE requisitions SET department_id = ? WHERE department = ? AND department_id IS NULL").run(dept.id, name);
  }
}

// Seeds exactly one account — Super Admin — and nothing else (no other users,
// categories, departments or items). Used by db/reset.js for a true blank
// slate: the superadmin then creates every department, category, subcategory,
// item and other user from the app itself.
function seedSuperadminOnly() {
  const defaultPassword = "Passw0rd!";
  const hash = bcrypt.hashSync(defaultPassword, 10);
  const info = db
    .prepare(
      `INSERT INTO users(name, email, password_hash, role, department, is_active, created_at)
       VALUES (?,?,?,?,?,1,?)`
    )
    .run("System Super Admin", "superadmin@plasu.edu.ng", hash, "superadmin", "", nowIso());
  db.prepare(`INSERT INTO user_roles(user_id, role, created_at) VALUES (?,?,?)`).run(
    info.lastInsertRowid,
    "superadmin",
    nowIso()
  );
  console.log(`Seeded 1 Super Admin account (superadmin@plasu.edu.ng). Password: ${defaultPassword}`);
}

// Full demo dataset (8 role accounts, default categories/departments, 4 sample
// items) — used ONLY when explicitly asked for (`node db/reset.js --demo`).
// Never runs automatically on boot: a fresh or deliberately-cleared database
// should stay exactly as empty as the operator left it, not have a demo
// account resurrected on every restart.
function seedDemoData() {
  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (userCount === 0) {
    const defaultPassword = "Passw0rd!";
    const hash = bcrypt.hashSync(defaultPassword, 10);
    const insert = db.prepare(
      `INSERT INTO users(name, email, password_hash, role, department, is_active, created_at)
       VALUES (?,?,?,?,?,1,?)`
    );
    insert.run("System Super Admin", "superadmin@plasu.edu.ng", hash, "superadmin", "ICT/Admin", nowIso());
    insert.run("ICT Admin", "ictadmin@plasu.edu.ng", hash, "ictadmin", "ICT Unit", nowIso());
    insert.run("HOD Computer Science", "hod.cs@plasu.edu.ng", hash, "hod", "Computer Science", nowIso());
    insert.run("Head of Store", "headofstore@plasu.edu.ng", hash, "head_of_store", "Central Store", nowIso());
    insert.run("Issuance Officer", "issuance@plasu.edu.ng", hash, "issuance_officer", "Central Store", nowIso());
    insert.run("Technical Expert", "technical@plasu.edu.ng", hash, "technical_expert", "Works/Technical Unit", nowIso());
    insert.run("Audit Officer", "audit@plasu.edu.ng", hash, "audit_officer", "Internal Audit Unit", nowIso());
    insert.run("Asset & Insurance Officer", "asset@plasu.edu.ng", hash, "asset_officer", "Asset Management Unit", nowIso());
    console.log(`Seeded 8 default users. Default password for all: ${defaultPassword}`);
  }

  // Seed default item categories.
  const categoryCount = db.prepare("SELECT COUNT(*) AS c FROM categories").get().c;
  if (categoryCount === 0) {
    const superadmin = db.prepare("SELECT id FROM users WHERE role='superadmin'").get();
    const createdBy = superadmin ? superadmin.id : null;
    const insertCat = db.prepare(
      `INSERT INTO categories(name, code, description, is_active, created_by, created_at) VALUES (?,?,?,1,?,?)`
    );
    insertCat.run("Stationery", "STA", "Paper, writing instruments, filing supplies and general office consumables.", createdBy, nowIso());
    insertCat.run("Furniture", "FUR", "Desks, chairs, cabinets and other office/lab furniture.", createdBy, nowIso());
    insertCat.run("Electronics & IT", "ELE", "Computers, peripherals, cabling and IT accessories.", createdBy, nowIso());
    insertCat.run("Consumables", "CON", "Toners, cleaning supplies and other items that are regularly used up.", createdBy, nowIso());
    insertCat.run("General", "GEN", "Items that do not fit another category.", createdBy, nowIso());
    console.log("Seeded default item categories.");
  }

  const deptCount = db.prepare("SELECT COUNT(*) AS c FROM departments").get().c;
  if (deptCount === 0) {
    const insertDept = db.prepare(
      `INSERT INTO departments(name, code, is_active, created_at) VALUES (?,?,1,?)`
    );
    insertDept.run("ICT Unit", "ICT", nowIso());
    insertDept.run("Computer Science", "CS", nowIso());
    insertDept.run("Central Store", "STORE", nowIso());
    insertDept.run("Works/Technical Unit", "WORKS", nowIso());
    insertDept.run("Internal Audit Unit", "AUDIT", nowIso());
    insertDept.run("Asset Management Unit", "ASSET", nowIso());
    console.log("Seeded default departments.");
  }

  const itemCount = db.prepare("SELECT COUNT(*) AS c FROM items").get().c;
  if (itemCount === 0) {
    const ictadmin = db.prepare("SELECT id FROM users WHERE email = ?").get("ictadmin@plasu.edu.ng");
    const staCat = db.prepare("SELECT id FROM categories WHERE code='STA'").get();
    const conCat = db.prepare("SELECT id FROM categories WHERE code='CON'").get();
    if (ictadmin) {
      const insertItem = db.prepare(
        `INSERT INTO items(code, name, description, unit, quantity_on_hand, reorder_level, category_id, is_active, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,1,?,?)`
      );
      const insertPkg = db.prepare(
        `INSERT INTO item_packagings(item_id, label, units_per_pack, is_default, is_active, created_at) VALUES (?,?,?,?,1,?)`
      );

      const paper = insertItem.run("STA-0001", "A4 Paper Ream", "White A4 photocopy paper, 80gsm", "sheet", 200 * 500, 30 * 500, staCat ? staCat.id : null, ictadmin.id, nowIso());
      insertPkg.run(paper.lastInsertRowid, "Single Sheet", 1, 0, nowIso());
      insertPkg.run(paper.lastInsertRowid, "Ream (500 sheets)", 500, 1, nowIso());
      insertPkg.run(paper.lastInsertRowid, "Carton (5 Reams)", 2500, 0, nowIso());

      const pencil = insertItem.run("STA-0002", "HB Pencil", "Standard HB writing pencil", "piece", 500, 100, staCat ? staCat.id : null, ictadmin.id, nowIso());
      insertPkg.run(pencil.lastInsertRowid, "Single Piece", 1, 1, nowIso());
      insertPkg.run(pencil.lastInsertRowid, "Pack of 12", 12, 0, nowIso());
      insertPkg.run(pencil.lastInsertRowid, "Pack of 24", 24, 0, nowIso());

      const toner = insertItem.run("CON-0001", "Printer Toner (HP 12A)", "Black toner cartridge", "piece", 15, 5, conCat ? conCat.id : null, ictadmin.id, nowIso());
      insertPkg.run(toner.lastInsertRowid, "Single Cartridge", 1, 1, nowIso());

      const boxFile = insertItem.run("STA-0003", "Box File", "Standard cardboard box file", "piece", 80, 20, staCat ? staCat.id : null, ictadmin.id, nowIso());
      insertPkg.run(boxFile.lastInsertRowid, "Single Piece", 1, 1, nowIso());
      insertPkg.run(boxFile.lastInsertRowid, "Pack of 10", 10, 0, nowIso());

      console.log("Seeded 4 sample inventory items with packaging tiers.");
    }
  }
}

// Fresh install (or a deliberately-cleared one, see db/reset.js) gets a single
// Super Admin account — nothing more. This is the ONLY thing that runs
// automatically at boot; it never resurrects demo accounts, categories,
// departments or sample items that an operator removed on purpose.
function seedIfEmpty() {
  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (userCount === 0) {
    seedSuperadminOnly();
  }
}

// Data-integrity backfill for pre-existing items from an older install (not
// demo content, so this runs on every boot regardless of seed mode): items
// missing a category, or missing any packaging tier.
function backfillItemIntegrity() {
  const genCat = db.prepare("SELECT id FROM categories WHERE code='GEN'").get();
  const itemsMissingCat = db.prepare("SELECT id FROM items WHERE category_id IS NULL").all();
  for (const it of itemsMissingCat) {
    db.prepare("UPDATE items SET category_id = ? WHERE id = ?").run(genCat ? genCat.id : null, it.id);
  }
  const itemsMissingPkg = db
    .prepare(
      `SELECT i.id, i.unit FROM items i
       WHERE NOT EXISTS (SELECT 1 FROM item_packagings p WHERE p.item_id = i.id)`
    )
    .all();
  const insertPkg = db.prepare(
    `INSERT INTO item_packagings(item_id, label, units_per_pack, is_default, is_active, created_at) VALUES (?,?,1,1,1,?)`
  );
  for (const it of itemsMissingPkg) {
    insertPkg.run(it.id, `Single ${it.unit}`, nowIso());
  }
  if (itemsMissingPkg.length > 0) {
    console.log(`Backfilled default "Single" packaging for ${itemsMissingPkg.length} existing item(s).`);
  }
}

initSchema();
migrateSchema();
seedIfEmpty();
backfillItemIntegrity();
migrateDepartmentsFromText();
backfillUserRoles();

module.exports = {
  db,
  ROLES,
  ROLE_PRIORITY,
  SIGNOFF_ROLES,
  CLEARANCE_ROLES,
  BACKOFFICE_ROLES,
  primaryRole,
  nowIso,
  nextReqNo,
  nextClearanceRef,
  nextItemCode,
  nextDeptCode,
  nextCategoryCode,
  nextSubcategoryCode,
  rolesForUser,
  setUserRoles,
  audit,
  notifyUsers,
  notifyRoles,
  notifyUser,
  checkLowStockAndNotify,
  seedIfEmpty,
  seedSuperadminOnly,
  seedDemoData,
  backfillUserRoles,
};
