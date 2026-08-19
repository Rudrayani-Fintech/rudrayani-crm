import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/db";
import { hashPassword } from "../src/services/auth-service";

const app = createApp();
const PASSWORD = "Secret@123";
const AGENT_PHONE = "7960000001";
const AGENT2_PHONE = "7960000002";

let agencyId: string;
let companyId: string;
let customerId: string;
let dispositionCodeId: string;
let ptpDispositionCodeId: string;
let agentToken: string;
let agent2Token: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ phone, password: PASSWORD });
  return res.body.access_token;
}

beforeAll(async () => {
  const agency = await pool.query("INSERT INTO agencies (name) VALUES ('CL Edit Agency') RETURNING id");
  agencyId = agency.rows[0].id;
  const company = await pool.query(
    "INSERT INTO companies (agency_id, name) VALUES ($1, 'CL Edit NBFC') RETURNING id",
    [agencyId],
  );
  companyId = company.rows[0].id;

  const hash = await hashPassword(PASSWORD);
  const agent = await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'CL Edit Agent', $2, $3, true, 'telecaller') RETURNING id`,
    [agencyId, AGENT_PHONE, hash],
  );
  await pool.query(
    `INSERT INTO users (agency_id, full_name, phone, password_hash, is_telecaller, designation)
     VALUES ($1, 'CL Edit Agent 2', $2, $3, true, 'telecaller')`,
    [agencyId, AGENT2_PHONE, hash],
  );

  const customer = await pool.query(
    `INSERT INTO customers (company_id, loan_number, customer_name, mobile_number, due_amount, assigned_agent_id)
     VALUES ($1, 'CLE-001', 'Edit Test Customer', '9800000001', 20000, $2) RETURNING id`,
    [companyId, agent.rows[0].id],
  );
  customerId = customer.rows[0].id;

  const code = await pool.query(
    `INSERT INTO disposition_codes (agency_id, action_code, category, result_code, description, remark_template)
     VALUES ($1, 'OC', 'NO CONTACT', 'RNR', 'Ringing No Response', 'Ringing No Response') RETURNING id`,
    [agencyId],
  );
  dispositionCodeId = code.rows[0].id;

  const ptpCode = await pool.query(
    `INSERT INTO disposition_codes
       (agency_id, action_code, category, result_code, description, remark_template, needs_amount, needs_date)
     VALUES ($1, 'OC', 'PROMISE TO PAY', 'PTP', 'Promise to Pay', 'PTP of <amount> on <date>', true, true)
     RETURNING id`,
    [agencyId],
  );
  ptpDispositionCodeId = ptpCode.rows[0].id;

  agentToken = await login(AGENT_PHONE);
  agent2Token = await login(AGENT2_PHONE);
});

afterAll(async () => {
  // ptps.call_log_id FKs to call_logs -- the PTP-edit test below creates a
  // ptps row, so it must be cleared before call_logs or the delete violates
  // ptps_call_log_id_fkey.
  await pool.query("DELETE FROM ptps WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM call_logs WHERE customer_id = $1", [customerId]);
  await pool.query("DELETE FROM disposition_codes WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM customers WHERE id = $1", [customerId]);
  await pool.query("DELETE FROM users WHERE agency_id = $1", [agencyId]);
  await pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
  await pool.end();
});

describe("call log remark edit", () => {
  it("owner edits their extra_remark within the window; composed portion is preserved", async () => {
    const create = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        customer_id: customerId,
        disposition_code_id: dispositionCodeId,
        fields: {},
        extra_remark: "will call back tomorrow",
      });
    expect(create.status).toBe(201);
    const callLogId = create.body.call_log.id;
    expect(create.body.call_log.remark).toBe("Ringing No Response — will call back tomorrow");

    const edit = await request(app)
      .patch(`/api/call-logs/${callLogId}/remark`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ extra_remark: "actually said call after 6pm" });
    expect(edit.status).toBe(200);
    expect(edit.body.call_log.remark).toBe("Ringing No Response — actually said call after 6pm");
    expect(edit.body.call_log.extra_remark).toBe("actually said call after 6pm");
    expect(edit.body.call_log.edited_at).not.toBeNull();
  });

  it("a non-owner cannot edit (404)", async () => {
    const create = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customerId, disposition_code_id: dispositionCodeId, fields: {} });
    const callLogId = create.body.call_log.id;

    const edit = await request(app)
      .patch(`/api/call-logs/${callLogId}/remark`)
      .set("Authorization", `Bearer ${agent2Token}`)
      .send({ extra_remark: "not mine to edit" });
    expect(edit.status).toBe(404);
  });

  it("rejects an edit once the call log is more than 24h old (409)", async () => {
    const create = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ customer_id: customerId, disposition_code_id: dispositionCodeId, fields: {} });
    const callLogId = create.body.call_log.id;
    await pool.query("UPDATE call_logs SET created_at = now() - interval '25 hours' WHERE id = $1", [callLogId]);

    const edit = await request(app)
      .patch(`/api/call-logs/${callLogId}/remark`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ extra_remark: "too late now" });
    expect(edit.status).toBe(409);
  });

  it("editing the remark on a PTP call log leaves the disposition, details, and linked PTP untouched", async () => {
    const create = await request(app)
      .post("/api/call-logs")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        customer_id: customerId,
        disposition_code_id: ptpDispositionCodeId,
        fields: { amount: 5000, date: "2026-09-01" },
        extra_remark: "will pay via UPI",
      });
    expect(create.status).toBe(201);
    const callLogId = create.body.call_log.id;
    const ptpId = create.body.ptp.id;
    expect(Number(create.body.ptp.amount)).toBe(5000);
    expect(create.body.ptp.promised_date).toBe("2026-09-01");
    expect(create.body.ptp.status).toBe("pending");

    const edit = await request(app)
      .patch(`/api/call-logs/${callLogId}/remark`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ extra_remark: "actually paying via NEFT" });
    expect(edit.status).toBe(200);
    expect(edit.body.call_log.extra_remark).toBe("actually paying via NEFT");
    expect(edit.body.call_log.edited_at).not.toBeNull();

    const callLogRow = await pool.query(
      "SELECT disposition_code_id, details, remark, extra_remark, edited_at FROM call_logs WHERE id = $1",
      [callLogId],
    );
    // disposition_code_id and details (the structured fields the PTP/remark
    // were derived from) must be byte-for-byte unchanged by the edit --
    // only remark/extra_remark/edited_at are allowed to differ.
    expect(callLogRow.rows[0].disposition_code_id).toBe(ptpDispositionCodeId);
    expect(callLogRow.rows[0].details).toEqual({ amount: 5000, date: "2026-09-01" });
    expect(callLogRow.rows[0].remark).not.toBe(create.body.call_log.remark);

    const ptpRow = await pool.query("SELECT amount, promised_date, status FROM ptps WHERE id = $1", [ptpId]);
    expect(Number(ptpRow.rows[0].amount)).toBe(5000);
    expect(ptpRow.rows[0].status).toBe("pending");
    expect(ptpRow.rows[0].promised_date).toBe("2026-09-01");
  });
});
