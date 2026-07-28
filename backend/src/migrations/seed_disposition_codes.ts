/**
 * Seeds the disposition_codes table directly from Trail_Codes.xlsx
 * so you never have to hand-retype the 70-row master list.
 *
 * Usage:
 *   npm run seed:dispositions -- <agency_id>
 */
import path from "node:path";
import ExcelJS from "exceljs";
import { pool } from "../config/db";

const FILE_PATH = path.join(__dirname, "Trail_Codes.xlsx");

type CellValue = string | number | undefined | null;

function cellText(value: ExcelJS.CellValue): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    // Rich text / hyperlink / formula-result cells.
    const v = value as { text?: string; result?: unknown };
    if (typeof v.text === "string") return v.text;
    if (v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
    return null;
  }
  return value as CellValue;
}

// Best-effort keyword tagging of which structured fields a template needs.
// Review/adjust this mapping after the first run -- it's a starting point,
// not a substitute for an admin UI to edit these later (see build brief Section 7).
function detectNeeds(template = "") {
  const t = template.toLowerCase();
  return {
    needs_amount: t.includes("<amount>") || t.includes("<mention amount>"),
    needs_date: t.includes("<date>"),
    needs_time: t.includes("<time>"),
    needs_mode: t.includes("mode>"),
    needs_reason: t.includes("<reason>") || t.includes("mention reason"),
    needs_name_relation: t.includes("name & relation") || t.includes("name &amp; relation"),
  };
}

async function run(): Promise<void> {
  const agencyId = process.argv[2];
  if (!agencyId) {
    console.error("Usage: npm run seed:dispositions -- <agency_id>");
    process.exit(1);
  }

  // Was the xlsx package (known advisories, unmaintained) -- exceljs is
  // already a dependency and used everywhere else in this codebase for the
  // same job, so this was the one remaining reason xlsx was installed at all.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(FILE_PATH);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Trail_Codes.xlsx has no worksheets");

  // Row 1 is the header: Sr, Action Code, Majorly used result code, Result code, Description, Remarks
  const dataRows: CellValue[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells: CellValue[] = [];
    for (let col = 1; col <= 6; col++) cells.push(cellText(row.getCell(col).value));
    if (cells.some((c) => c !== undefined && c !== null)) dataRows.push(cells);
  });

  let inserted = 0;
  // Some rows carry only a remark: they are extra remark-template variants of the
  // disposition code above them (e.g. rows 3-10 are all "CB" call-back variants).
  // Forward-fill the parent's codes so every variant is preserved as its own row.
  let last: {
    actionCode: CellValue;
    category: CellValue;
    resultCode: CellValue;
    description: CellValue;
  } = { actionCode: null, category: null, resultCode: null, description: null };

  for (const row of dataRows) {
    const [, actionCodeRaw, categoryRaw, resultCodeRaw, descriptionRaw, remarkTemplate] = row;
    let actionCode = actionCodeRaw;
    let category = categoryRaw;
    let resultCode = resultCodeRaw;
    let description = descriptionRaw;
    if (!actionCode && !description) {
      if (!remarkTemplate) continue; // skip fully blank rows
      ({ actionCode, category, resultCode, description } = last);
    } else {
      last = { actionCode, category, resultCode, description };
    }

    const needs = detectNeeds(String(remarkTemplate ?? ""));

    await pool.query(
      `INSERT INTO disposition_codes
        (agency_id, action_code, category, result_code, description, remark_template,
         needs_amount, needs_date, needs_time, needs_mode, needs_reason, needs_name_relation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        agencyId,
        actionCode || null,
        category || null,
        resultCode ? String(resultCode) : null,
        description || null,
        remarkTemplate || null,
        needs.needs_amount,
        needs.needs_date,
        needs.needs_time,
        needs.needs_mode,
        needs.needs_reason,
        needs.needs_name_relation,
      ],
    );
    inserted += 1;
  }

  console.log(`Seeded ${inserted} disposition codes for agency ${agencyId}`);
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
