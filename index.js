const sql = require("mssql");

// Pool Reuse (wichtig für Azure Functions Performance)
let poolPromise;

/**
 * Incidents Tabelle (aus deinem Screenshot):
 * Id, Title, Description, Status, CreatedAt, CreatedBy,
 * Ai_Category, Ai_Priority, Ai_Confidence,
 * Category, Priority, Impact, Urgency, Service, Source,
 * RequesterEmail, AssigneeTeamId, AssigneeUserId,
 * UpdatedAt, ResolvedAt,
 * ResponseDueAt, ResolutionDueAt, SlaBreached
 */
module.exports = async function (context, req) {
  context.log("CreateIncident called");

  try {
    // ---------- 1) Input lesen + validieren ----------
    const body = req.body || {};

    const title = (body.title ?? "").toString().trim();
    const description = (body.description ?? "").toString().trim();

    // akzeptiere createdBy oder userId
    const createdBy = (body.createdBy ?? body.userId ?? "").toString().trim();

    if (!title || !description || !createdBy) {
      context.res = {
        status: 400,
        body: {
          error: "Missing required fields",
          required: ["title", "description", "createdBy (or userId)"],
        },
      };
      return;
    }

    // Optionale Felder (aus eurem JSON)
    const category = body.category ?? null;
    const priority = body.priority ?? null;      // z.B. "P2"
    const impact = body.impact ?? null;          // z.B. "HIGH"
    const urgency = body.urgency ?? null;        // z.B. "MEDIUM"
    const service = body.service ?? null;
    const source = (body.source ?? "PORTAL").toString().trim();

    const requesterEmail = (body.requesterEmail ?? body.email ?? "").toString().trim() || null;

    const assigneeTeamId = body.assigneeTeamId ?? null;
    const assigneeUserId = body.assigneeUserId ?? null;

    // SLA optional (kann später von Logic App gesetzt werden)
    const responseDueAt = body.responseDueAt ? new Date(body.responseDueAt) : null;
    const resolutionDueAt = body.resolutionDueAt ? new Date(body.resolutionDueAt) : null;

    // Optional KI-Felder (normalerweise später per Logic App setzen)
    const aiCategory = body.aiCategory ?? null;
    const aiPriority = body.aiPriority ?? null;
    const aiConfidence =
      body.aiConfidence === 0 || body.aiConfidence
        ? Number(body.aiConfidence)
        : null;

    // ---------- 2) DB Config (ENV) ----------
    const server = process.env.DB_SERVER;
    const database = process.env.DB_NAME;
    const user = process.env.DB_USER;
    const password = process.env.DB_PASSWORD;

    if (!server || !database || !user || !password) {
      context.res = {
        status: 500,
        body: {
          error: "DB env vars missing",
          needed: ["DB_SERVER", "DB_NAME", "DB_USER", "DB_PASSWORD"],
        },
      };
      return;
    }

    const config = {
      user,
      password,
      server,   // z.B. "sqlserver-proj2.database.windows.net"
      database,
      options: {
        encrypt: true,
        trustServerCertificate: false,
      },
      pool: {
        max: 5,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };

    // ---------- 3) Connect (Pool Reuse) ----------
    if (!poolPromise) {
      poolPromise = sql.connect(config);
    }
    const pool = await poolPromise;

    // ---------- 4) Parameterized INSERT + OUTPUT ----------
    const r = pool.request();

    // Required
    r.input("Title", sql.NVarChar(200), title);
    r.input("Description", sql.NVarChar(sql.MAX), description);
    r.input("Status", sql.NVarChar(20), "NEW");
    r.input("CreatedBy", sql.NVarChar(100), createdBy);

    // Business
    r.input("Category", sql.NVarChar(100), category);
    r.input("Priority", sql.NVarChar(10), priority);
    r.input("Impact", sql.NVarChar(10), impact);
    r.input("Urgency", sql.NVarChar(10), urgency);
    r.input("Service", sql.NVarChar(100), service);
    r.input("Source", sql.NVarChar(20), source);

    // Requester/Assignee
    r.input("RequesterEmail", sql.NVarChar(200), requesterEmail);
    r.input("AssigneeTeamId", sql.NVarChar(50), assigneeTeamId);
    r.input("AssigneeUserId", sql.NVarChar(50), assigneeUserId);

    // SLA
    r.input("ResponseDueAt", sql.DateTime2, responseDueAt);
    r.input("ResolutionDueAt", sql.DateTime2, resolutionDueAt);

    // AI (optional)
    r.input("Ai_Category", sql.NVarChar(100), aiCategory);
    r.input("Ai_Priority", sql.NVarChar(10), aiPriority);
    r.input("Ai_Confidence", sql.Decimal(4, 3), aiConfidence);

    const insertSql = `
      INSERT INTO dbo.Incidents (
        Title, Description, Status, CreatedAt, CreatedBy,
        Category, Priority, Impact, Urgency, Service, Source,
        RequesterEmail, AssigneeTeamId, AssigneeUserId,
        UpdatedAt, ResolvedAt,
        ResponseDueAt, ResolutionDueAt, SlaBreached,
        Ai_Category, Ai_Priority, Ai_Confidence
      )
      OUTPUT INSERTED.*
      VALUES (
        @Title, @Description, @Status, SYSUTCDATETIME(), @CreatedBy,
        @Category, @Priority, @Impact, @Urgency, @Service, @Source,
        @RequesterEmail, @AssigneeTeamId, @AssigneeUserId,
        SYSUTCDATETIME(), NULL,
        @ResponseDueAt, @ResolutionDueAt, 0,
        @Ai_Category, @Ai_Priority, @Ai_Confidence
      );
    `;

    const result = await r.query(insertSql);
    const created = result.recordset?.[0];

    context.res = {
      status: 201,
      body: {
        message: "Incident created",
        incident: created,
      },
    };
  } catch (err) {
    // WICHTIG: echte DB Fehlermeldung zurückgeben (für Debugging)
    context.log.error("CreateIncident ERROR:", err);

    context.res = {
      status: 500,
      body: {
        error: "CreateIncident failed",
        message: err?.message || String(err),
      },
    };
  }
};
