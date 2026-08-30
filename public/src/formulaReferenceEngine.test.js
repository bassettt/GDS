// اختبارات formulaReferenceEngine.js — تُشغَّل عبر: node formulaReferenceEngine.test.js
const FRE = require("./formulaReferenceEngine.js");

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const ok = actual === expected;
  if (ok) { pass++; }
  else { fail++; console.error(`✗ ${label}\n   expected: ${expected}\n   actual:   ${actual}`); }
}

// ── 1) Parser: استخراج المراجع بأنماطها الأربعة ──────────────
{
  const refs = FRE.extractCellRefs("=C24+$C24+D$24+$D$24");
  assertEq(refs.length, 4, "parser: يستخرج 4 مراجع");
  assertEq(refs[0].ref, "C24", "parser: C24 خام");
  assertEq(refs[0].colFrozen, false, "parser: C24 col غير مجمد");
  assertEq(refs[0].rowFrozen, false, "parser: C24 row غير مجمد");
  assertEq(refs[1].ref, "$C24", "parser: $C24 خام");
  assertEq(refs[1].colFrozen, true, "parser: $C24 col مجمد");
  assertEq(refs[1].rowFrozen, false, "parser: $C24 row غير مجمد");
  assertEq(refs[2].ref, "D$24", "parser: D$24 خام");
  assertEq(refs[2].colFrozen, false, "parser: D$24 col غير مجمد");
  assertEq(refs[2].rowFrozen, true, "parser: D$24 row مجمد");
  assertEq(refs[3].ref, "$D$24", "parser: $D$24 خام");
  assertEq(refs[3].colFrozen, true, "parser: $D$24 col مجمد");
  assertEq(refs[3].rowFrozen, true, "parser: $D$24 row مجمد");
}

// ── parser: يتجاهل أسماء الدوال والنصوص المقتبسة ─────────────
{
  const refs = FRE.extractCellRefs('=SUMIFS(A1,"B2",C3)');
  const raw = refs.map(r => r.ref);
  assertEq(raw.includes("B2"), false, "parser: يتجاهل النص المقتبس \"B2\"");
  assertEq(raw.join(","), "A1,C3", "parser: يستخرج A1 وC3 فقط ويتجاهل اسم الدالة SUMIFS");
}

// ── 2) Fill/Drag: سحب لأسفل بدون $ — تحديث رقم الصف فقط ─────
{
  const out = FRE.shiftRefsForFill("=A1+B2", 3, 0);
  assertEq(out, "=A4+B5", "fill down: يحدث الصف فقط");
}

// ── Fill/Drag: سحب لليمين بدون $ — تحديث حرف العمود فقط ──────
{
  const out = FRE.shiftRefsForFill("=A1+B2", 0, 2);
  assertEq(out, "=C1+D2", "fill right: يحدث العمود فقط");
}

// ── Fill/Drag: مراجع مجمّدة جزئيًا — $ يمنع التحديث بالاتجاه المطابق فقط ──
{
  // سحب لأسفل (rowDelta=5): $C24 (عمود مجمد) col ثابت C، والصف يتحرك لأنه غير مجمد
  const down = FRE.shiftRefsForFill("=$C24+D$24+$D$24", 5, 0);
  assertEq(down, "=$C29+D$24+$D$24", "fill down + $: $C24->$C29 (صف يتحرك)، D$24 و$D$24 يبقيان (صف مجمد)");

  // سحب لليمين (colDelta=2): $C24 يبقى (عمود مجمد)، D$24 يتحرك عموديًا فقط
  const right = FRE.shiftRefsForFill("=$C24+D$24+$D$24", 0, 2);
  assertEq(right, "=$C24+F$24+$D$24", "fill right + $: $C24 و$D$24 يبقيان (عمود مجمد)، D$24->F$24");
}

// ── Fill/Drag: سحب متعدد الخلايا (كل خلية بموقعها) — محاكاة يدوية ──
{
  // مصدر A1 يحتوي =B1, نسحبه لأسفل إلى A2 وA3 — كل خلية تُحسب حسب مسافتها
  const toA2 = FRE.shiftRefsForFill("=B1", 1, 0); // rowDelta=1
  const toA3 = FRE.shiftRefsForFill("=B1", 2, 0); // rowDelta=2
  assertEq(toA2, "=B2", "multi-fill: الخلية الأولى بعد المصدر بمسافة 1");
  assertEq(toA3, "=B3", "multi-fill: الخلية الثانية بعد المصدر بمسافة 2");
}

// ── 3) Insert: إدراج عمود بعد B (index=2, delta=+1) ─────────
{
  // C24 عمود index=2 (>= atIndex=2) => يصبح D24
  const out = FRE.shiftRefsForInsertDelete("=C24+A1+$C24+D$24", "col", 2, +1);
  assertEq(out, "=D24+A1+$D24+E$24", "insert col after B: كل مرجع من C فما بعد يزاد عمودًا بواحد، بغض النظر عن $");
  // A1 عمود index=0 (< atIndex=2) => يبقى كما هو
}

// ── Delete: حذف عمود عند index=2 (كان C) ─────────────────────
{
  const out = FRE.shiftRefsForInsertDelete("=D24+A1+$D24+E$24", "col", 2, -1);
  assertEq(out, "=C24+A1+$C24+D$24", "delete col at C: كل مرجع بعد C ينقص عمودًا بواحد");
}

// ── Insert row ────────────────────────────────────────────
{
  const out = FRE.shiftRefsForInsertDelete("=A5+$A5+A$5+$A$5", "row", 4, +1); // atIndex=4 -> يشمل الصف 5 (row index 4)
  assertEq(out, "=A6+$A6+A$6+$A$6", "insert row at index4: كل المراجع من الصف5 (index4) فما بعد تزاد صفًا، رغم $");
}

// ── remapAllFormulas: تحديث خريطة raw كاملة دفعة واحدة ────────
{
  const map = { A1: "=C24", B2: "=$C24+D$24" };
  const out = FRE.remapAllFormulas(map, "col", 2, +1);
  assertEq(out.A1, "=D24", "remapAllFormulas: A1 محدثة");
  assertEq(out.B2, "=$D24+E$24", "remapAllFormulas: B2 محدثة مع احترام تجاهل $ (تحديث هيكلي)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
