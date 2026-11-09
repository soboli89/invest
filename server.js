require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const express = require("express");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const helmet = require("helmet");
const nodemailer = require("nodemailer");

const app = express();
const port = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === "production";
const dataDirectory = path.join(__dirname, "data");
let mailTransport;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be set to a random value of at least 32 characters.");
}

const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(dataDirectory, "portfolio.db"));
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'client')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Active'
      CHECK (status IN ('Active', 'In progress', 'Completed', 'On hold')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS project_clients (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invested_cents INTEGER CHECK (invested_cents IS NULL OR invested_cents >= 0),
    PRIMARY KEY (project_id, client_id)
  );

  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
    published_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);
  CREATE INDEX IF NOT EXISTS project_clients_client_idx ON project_clients(client_id);
`);

const projectColumns = new Set(db.pragma("table_info(projects)").map((column) => column.name));
if (!projectColumns.has("length_months")) {
  db.exec("ALTER TABLE projects ADD COLUMN length_months INTEGER");
}
if (!projectColumns.has("annual_rate")) {
  db.exec("ALTER TABLE projects ADD COLUMN annual_rate REAL");
}
if (!projectColumns.has("start_date")) {
  db.exec("ALTER TABLE projects ADD COLUMN start_date TEXT");
}
if (!projectColumns.has("expected_finish_date")) {
  db.exec("ALTER TABLE projects ADD COLUMN expected_finish_date TEXT");
}
const projectClientColumns = new Set(db.pragma("table_info(project_clients)").map((column) => column.name));
if (!projectClientColumns.has("invested_cents")) {
  db.exec("ALTER TABLE project_clients ADD COLUMN invested_cents INTEGER CHECK (invested_cents IS NULL OR invested_cents >= 0)");
}

const adminCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
if (adminCount === 0) {
  const email = normalizeEmail(process.env.ADMIN_EMAIL || "");
  const password = process.env.ADMIN_PASSWORD || "";
  if (!isValidEmail(email) || !isValidPassword(password)) {
    throw new Error(
      "No administrator exists. Set a valid ADMIN_EMAIL and an ADMIN_PASSWORD of 12-72 UTF-8 bytes, then restart.",
    );
  }
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(
    "Administrator",
    email,
    bcrypt.hashSync(password, 12),
  );
  console.log(`Created the first administrator account: ${email}`);
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPassword(password) {
  const length = Buffer.byteLength(password, "utf8");
  return length >= 12 && length <= 72;
}

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.database = database;
    this.getStatement = database.prepare("SELECT sess FROM sessions WHERE sid = ? AND expire > ?");
    this.setStatement = database.prepare(`
      INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
    `);
    this.destroyStatement = database.prepare("DELETE FROM sessions WHERE sid = ?");
    this.touchStatement = database.prepare("UPDATE sessions SET expire = ? WHERE sid = ?");
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expiresAt = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.setStatement.run(sid, JSON.stringify(sess), expiresAt);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      const expiresAt = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.touchStatement.run(expiresAt, sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

const sessionStore = new SQLiteSessionStore(db);

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));
app.use(
  session({
    name: "portfolio.sid",
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 12 * 60 * 60 * 1000,
    },
  }),
);
app.use(express.static(path.join(__dirname, "public")));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please try again in 15 minutes." },
});

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Please sign in to continue." });
  }
  const user = db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(req.session.userId);
  if (!user) {
    return req.session.destroy((error) => {
      if (error) return next(error);
      res.status(401).json({ error: "Your session has expired. Please sign in again." });
    });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Administrator access is required." });
  }
  next();
}

function daysInMonth(year, month) {
  if (month === 2) {
    const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return isLeapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidDateString(dateString) {
  if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return false;
  const [year, month, day] = dateString.split("-").map(Number);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function addMonthsToDate(dateString, months) {
  const [year, month, day] = dateString.split("-").map(Number);
  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  if (targetYear > 9999) return null;
  const targetMonth = (targetMonthIndex % 12) + 1;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function getMailTransport() {
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  const host = process.env.SMTP_HOST?.trim() || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const from = process.env.SMTP_FROM?.trim() || user;
  const missing = [];
  if (!user) missing.push("SMTP_USER");
  if (!password) missing.push("SMTP_PASSWORD");
  if (!from) missing.push("SMTP_FROM");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "SMTP_PORT must be a valid port from 1 to 65535." };
  }
  if (missing.length) return { missing };

  if (!mailTransport) {
    mailTransport = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === "true" || (process.env.SMTP_SECURE !== "false" && port === 465),
      authMethod: "LOGIN",
      auth: { user, pass: password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return { transport: mailTransport, from };
}

function getProjectEmailChanges(project, event, previousProject, currentAssignments) {
  if (event === "created") {
    return [
      "Project created.",
      `Project length: ${project.length_months} months.`,
      `Annual investment rate: ${project.annual_rate}%.`,
      `Start date: ${project.start_date}.`,
      `Expected finish: ${project.expected_finish_date}.`,
    ];
  }

  const changes = [];
  const fields = [
    ["Project name", previousProject.title, project.title],
    [
      "Project length",
      previousProject.length_months == null ? "not set" : `${previousProject.length_months} months`,
      project.length_months == null ? "not set" : `${project.length_months} months`,
    ],
    [
      "Annual investment rate",
      previousProject.annual_rate == null ? "not set" : `${previousProject.annual_rate}%`,
      project.annual_rate == null ? "not set" : `${project.annual_rate}%`,
    ],
    ["Start date", previousProject.start_date || "not set", project.start_date || "not set"],
    [
      "Expected finish date",
      previousProject.expected_finish_date || "not set",
      project.expected_finish_date || "not set",
    ],
    ["Status", previousProject.status, project.status],
  ];

  for (const [label, previousValue, currentValue] of fields) {
    if (previousValue !== currentValue) changes.push(`${label}: ${previousValue} → ${currentValue}.`);
  }
  if (previousProject.description !== project.description) {
    changes.push("Project description was updated.");
  }

  const previousClientIds = new Set(previousProject.clientInvestments.map((assignment) => assignment.client_id));
  const currentClientIds = new Set(currentAssignments.map((assignment) => assignment.id));
  if (
    previousClientIds.size !== currentClientIds.size ||
    [...previousClientIds].some((clientId) => !currentClientIds.has(clientId))
  ) {
    changes.push("Client access assignments were updated.");
  }

  if (!previousClientIds.has(project.id)) {
    changes.push("You were added to this project.");
  }

  return changes.length ? changes : ["No project details changed."];
}

async function sendProjectNotifications(projectId, event, previousProject = null) {
  const recipients = db.prepare(`
    SELECT u.id, u.name, u.email, p.title, p.description, p.length_months, p.annual_rate,
           p.status, p.start_date, p.expected_finish_date, pc.invested_cents AS amount_cents
    FROM project_clients pc
    JOIN users u ON u.id = pc.client_id
    JOIN projects p ON p.id = pc.project_id
    WHERE pc.project_id = ? AND u.role = 'client'
    ORDER BY u.id
  `).all(projectId);

  if (!recipients.length) return { configured: true, attempted: 0, sent: 0, failed: 0 };
  const mail = getMailTransport();
  if (mail.error) {
    console.error(`Project notification email configuration error: ${mail.error}`);
    return { configured: false, attempted: recipients.length, sent: 0, failed: recipients.length };
  }
  if (mail.missing) {
    console.error(`Project notification emails were not sent; missing ${mail.missing.join(", ")}.`);
    return { configured: false, attempted: recipients.length, sent: 0, failed: recipients.length };
  }

  let projectUrl;
  try {
    const url = new URL(process.env.PORTFOLIO_URL || "http://localhost:3000");
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("PORTFOLIO_URL must use HTTP or HTTPS.");
    projectUrl = url.toString().replace(/\/+$/, "");
  } catch (error) {
    console.error(`Project notification email configuration error: ${error.message}`);
    return { configured: false, attempted: recipients.length, sent: 0, failed: recipients.length };
  }

  const eventText = event === "created" ? "A project has been added to your portfolio" : "A project in your portfolio has been updated";
  const results = await Promise.allSettled(recipients.map((recipient) => {
    const changes = getProjectEmailChanges(recipient, event, previousProject, recipients);
    const changeListText = changes.map((change) => `- ${change}`).join("\n");
    const changeListHtml = changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("");
    return mail.transport.sendMail({
      from: mail.from,
      to: recipient.email,
      subject: `${event === "created" ? "New project" : "Project update"}: ${recipient.title.replace(/[\r\n]+/g, " ")}`,
      text: [
        `Hello ${recipient.name},`,
        "",
        eventText + ":",
        recipient.title,
        "",
        "What changed:",
        changeListText,
        "",
        `Sign in to your portfolio to see details: ${projectUrl}`,
      ].join("\n"),
      html: `
        <p>Hello ${escapeHtml(recipient.name)},</p>
        <p>${eventText}:</p>
        <h2>${escapeHtml(recipient.title)}</h2>
        <p><strong>What changed:</strong></p>
        <ul>${changeListHtml}</ul>
        <p><a href="${escapeHtml(projectUrl)}">Sign in to your portfolio to see details</a></p>
      `,
    });
  }));
  let sent = 0;
  let failed = 0;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      sent += 1;
    } else {
      failed += 1;
      console.error(`Project notification email failed for ${recipients[index].email}:`, result.reason);
    }
  });
  return { configured: true, attempted: recipients.length, sent, failed };
}

function validateProjectInput(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const lengthMonths = body.lengthMonths;
  const startDate = body.startDate;
  const annualRate = body.annualRate;
  const status = body.status;
  const clientInvestments = body.clientInvestments;

  if (!title || title.length > 120) {
    return { error: "Project title is required and must be 120 characters or fewer." };
  }
  if (description.length > 5000) {
    return { error: "Project description must be 5,000 characters or fewer." };
  }
  if (!Number.isSafeInteger(lengthMonths) || lengthMonths < 1 || lengthMonths > 1200) {
    return { error: "Project length must be a whole number of months between 1 and 1,200." };
  }
  if (!isValidDateString(startDate)) {
    return { error: "Enter a valid project start date." };
  }
  const expectedFinishDate = addMonthsToDate(startDate, lengthMonths);
  if (!expectedFinishDate) {
    return { error: "The project finish date is outside the supported date range." };
  }
  if (typeof annualRate !== "number" || !Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) {
    return { error: "Annual investment rate must be a percentage between 0 and 100." };
  }
  if (!["Active", "In progress", "Completed", "On hold"].includes(status)) {
    return { error: "Choose a valid project status." };
  }
  if (!Array.isArray(clientInvestments) || clientInvestments.length > 500) {
    return { error: "Select a valid list of clients and enter their investment amounts." };
  }
  const normalizedInvestments = [];
  const seenClientIds = new Set();
  for (const investment of clientInvestments) {
    const clientId = investment?.clientId;
    const amountCents = investment?.amountCents;
    if (!Number.isSafeInteger(clientId) || clientId < 1 || seenClientIds.has(clientId)) {
      return { error: "One or more selected clients are invalid." };
    }
    if (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > 99999999999) {
      return { error: "Each investment amount must be between $0.00 and $999,999,999.99 USD." };
    }
    seenClientIds.add(clientId);
    normalizedInvestments.push({ clientId, amountCents });
  }
  return {
    title,
    description,
    lengthMonths,
    startDate,
    expectedFinishDate,
    annualRate,
    status,
    clientInvestments: normalizedInvestments,
  };
}

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post("/api/login", loginLimiter, (req, res, next) => {
  const email = normalizeEmail(req.body?.email || "");
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const user = db.prepare("SELECT id, name, email, password_hash, role FROM users WHERE email = ?").get(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }

  req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.userId = user.id;
    req.session.save((saveError) => {
      if (saveError) return next(saveError);
      res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    });
  });
});

app.post("/api/logout", requireAuth, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie("portfolio.sid", { httpOnly: true, sameSite: "lax", secure: isProduction });
    res.status(204).end();
  });
});

app.post("/api/password", requireAuth, (req, res) => {
  const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
  const account = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, account.password_hash)) {
    return res.status(400).json({ error: "Current password is incorrect." });
  }
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ error: "New password must be 12-72 bytes long." });
  }
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(newPassword, 12), req.user.id);
  res.json({ message: "Password updated." });
});

app.get("/api/projects", requireAuth, (req, res) => {
  const projects =
    req.user.role === "admin"
      ? db.prepare(`
          SELECT p.id, p.title, p.description, p.length_months, p.start_date, p.expected_finish_date,
                 p.annual_rate, p.status, p.created_at, p.updated_at,
                 COALESCE(json_group_array(
                   CASE WHEN u.id IS NOT NULL THEN json_object(
                     'id', u.id, 'name', u.name, 'email', u.email, 'amount_cents', pc.invested_cents
                   ) END
                 ) FILTER (WHERE u.id IS NOT NULL), '[]') AS clients
          FROM projects p
          LEFT JOIN project_clients pc ON pc.project_id = p.id
          LEFT JOIN users u ON u.id = pc.client_id
          GROUP BY p.id
          ORDER BY p.updated_at DESC, p.id DESC
        `)
          .all()
          .map((project) => ({ ...project, clients: JSON.parse(project.clients) }))
      : db.prepare(`
          SELECT p.id, p.title, p.description, p.length_months, p.start_date, p.expected_finish_date,
                 p.annual_rate, p.status,
                 p.created_at, p.updated_at, pc.invested_cents AS amount_cents
          FROM projects p
          JOIN project_clients pc ON pc.project_id = p.id
          WHERE pc.client_id = ?
          ORDER BY p.updated_at DESC, p.id DESC
        `).all(req.user.id);

  res.json({ projects });
});

app.get("/api/news", requireAuth, (req, res) => {
  const articles = db.prepare(`
    SELECT id, title, content, published_at
    FROM news
    WHERE is_published = 1
    ORDER BY published_at DESC, id DESC
  `).all();
  res.json({ articles });
});

app.get("/api/admin/news", requireAuth, requireAdmin, (req, res) => {
  const articles = db.prepare(`
    SELECT id, title, content, is_published, published_at, created_at, updated_at
    FROM news
    ORDER BY updated_at DESC, id DESC
  `).all();
  res.json({ articles });
});

function validateNewsInput(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!title || title.length > 120) {
    return { error: "News title is required and must be 120 characters or fewer." };
  }
  if (!content || content.length > 10000) {
    return { error: "News content is required and must be 10,000 characters or fewer." };
  }
  if (typeof body.isPublished !== "boolean") {
    return { error: "Choose whether to publish this news article." };
  }
  return { title, content, isPublished: body.isPublished };
}

app.post("/api/admin/news", requireAuth, requireAdmin, (req, res) => {
  const article = validateNewsInput(req.body || {});
  if (article.error) return res.status(400).json({ error: article.error });
  const result = db.prepare(`
    INSERT INTO news (title, content, is_published, published_at)
    VALUES (?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END)
  `).run(article.title, article.content, Number(article.isPublished), Number(article.isPublished));
  res.status(201).json({ article: { id: Number(result.lastInsertRowid), ...article } });
});

app.put("/api/admin/news/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid news article ID." });
  const article = validateNewsInput(req.body || {});
  if (article.error) return res.status(400).json({ error: article.error });
  const result = db.prepare(`
    UPDATE news
    SET title = ?, content = ?, is_published = ?,
        published_at = CASE
          WHEN ? = 0 THEN NULL
          WHEN published_at IS NULL THEN CURRENT_TIMESTAMP
          ELSE published_at
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    article.title,
    article.content,
    Number(article.isPublished),
    Number(article.isPublished),
    id,
  );
  if (result.changes === 0) return res.status(404).json({ error: "News article not found." });
  res.json({ message: "News article updated." });
});

app.delete("/api/admin/news/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid news article ID." });
  const result = db.prepare("DELETE FROM news WHERE id = ?").run(id);
  if (result.changes === 0) return res.status(404).json({ error: "News article not found." });
  res.status(204).end();
});

app.get("/api/admin/clients", requireAuth, requireAdmin, (req, res) => {
  const clients = db
    .prepare("SELECT id, name, email, created_at FROM users WHERE role = 'client' ORDER BY name COLLATE NOCASE")
    .all();
  res.json({ clients });
});

app.post("/api/admin/clients", requireAuth, requireAdmin, (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = normalizeEmail(req.body?.email || "");
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!name || name.length > 100) {
    return res.status(400).json({ error: "Client name is required and must be 100 characters or fewer." });
  }
  if (!isValidEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: "Password must be 12-72 bytes long." });
  }

  try {
    const result = db
      .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'client')")
      .run(name, email, bcrypt.hashSync(password, 12));
    res.status(201).json({ client: { id: Number(result.lastInsertRowid), name, email } });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    throw error;
  }
});

app.delete("/api/admin/clients/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid client ID." });
  const result = db.prepare("DELETE FROM users WHERE id = ? AND role = 'client'").run(id);
  if (result.changes === 0) return res.status(404).json({ error: "Client account not found." });
  res.status(204).end();
});

app.post("/api/admin/projects", requireAuth, requireAdmin, async (req, res) => {
  const project = validateProjectInput(req.body || {});
  if (project.error) return res.status(400).json({ error: project.error });
  const saveProject = db.transaction(() => {
    const invalidClient = project.clientInvestments.some(
      ({ clientId }) => !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'client'").get(clientId),
    );
    if (invalidClient) return null;
    const result = db
      .prepare(`
        INSERT INTO projects
          (title, description, length_months, start_date, expected_finish_date, annual_rate, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        project.title,
        project.description,
        project.lengthMonths,
        project.startDate,
        project.expectedFinishDate,
        project.annualRate,
        project.status,
      );
    const insertAssignment = db.prepare(
      "INSERT INTO project_clients (project_id, client_id, invested_cents) VALUES (?, ?, ?)",
    );
    for (const { clientId, amountCents } of project.clientInvestments) {
      insertAssignment.run(result.lastInsertRowid, clientId, amountCents);
    }
    return Number(result.lastInsertRowid);
  });
  const id = saveProject();
  if (!id) return res.status(400).json({ error: "One or more selected clients do not exist." });
  const notifications = await sendProjectNotifications(id, "created");
  res.status(201).json({
    notifications,
    project: {
      id,
      title: project.title,
      description: project.description,
      length_months: project.lengthMonths,
      start_date: project.startDate,
      expected_finish_date: project.expectedFinishDate,
      annual_rate: project.annualRate,
      status: project.status,
      clientInvestments: project.clientInvestments,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
});

app.put("/api/admin/projects/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid project ID." });
  const project = validateProjectInput(req.body || {});
  if (project.error) return res.status(400).json({ error: project.error });
  const previousProject = db.prepare(`
    SELECT title, description, length_months, annual_rate, status, start_date, expected_finish_date
    FROM projects
    WHERE id = ?
  `).get(id);
  if (!previousProject) return res.status(404).json({ error: "Project not found." });
  previousProject.clientInvestments = db.prepare(`
    SELECT client_id, invested_cents
    FROM project_clients
    WHERE project_id = ?
  `).all(id);

  const updateProject = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
    if (!existing) return "missing";
    const invalidClient = project.clientInvestments.some(
      ({ clientId }) => !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'client'").get(clientId),
    );
    if (invalidClient) return "invalid-client";
    db.prepare(`
      UPDATE projects
      SET title = ?, description = ?, length_months = ?, start_date = ?, expected_finish_date = ?,
          annual_rate = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      project.title,
      project.description,
      project.lengthMonths,
      project.startDate,
      project.expectedFinishDate,
      project.annualRate,
      project.status,
      id,
    );
    db.prepare("DELETE FROM project_clients WHERE project_id = ?").run(id);
    const insertAssignment = db.prepare(
      "INSERT INTO project_clients (project_id, client_id, invested_cents) VALUES (?, ?, ?)",
    );
    for (const { clientId, amountCents } of project.clientInvestments) {
      insertAssignment.run(id, clientId, amountCents);
    }
    return "updated";
  });
  const result = updateProject();
  if (result === "missing") return res.status(404).json({ error: "Project not found." });
  if (result === "invalid-client") {
    return res.status(400).json({ error: "One or more selected clients do not exist." });
  }
  const notifications = await sendProjectNotifications(id, "updated", previousProject);
  res.json({ message: "Project updated.", notifications });
});

app.delete("/api/admin/projects/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid project ID." });
  const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  if (result.changes === 0) return res.status(404).json({ error: "Project not found." });
  res.status(204).end();
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({ error: "Request body must contain valid JSON." });
  }
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

const cleanupTimer = setInterval(() => {
  db.prepare("DELETE FROM sessions WHERE expire <= ?").run(Date.now());
}, 60 * 60 * 1000);
cleanupTimer.unref();

const server = app.listen(port, () => {
  console.log(`Portfolio app listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
