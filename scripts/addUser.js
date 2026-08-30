// scripts/addUser.js
// الاستخدام:
//   node scripts/addUser.js add "login" "note" "editor"
//   node scripts/addUser.js add "login" "note"            (الدور الافتراضي: viewer)
//   node scripts/addUser.js remove "login"
//
// ⚠️ يبقى هذا السكربت يعمل كبديل CLI للوحة الأدمن (/admin.html)، وكلاهما
// يستخدم الآن نفس المنطق المشترك في lib/users.js لتجنّب ازدواج الكود.
require("dotenv").config();
const { upsertUser, removeUser, VALID_ROLES } = require("../lib/users");

async function main() {
  const [action, rawLogin, note, rawRole] = process.argv.slice(2);
  if (!action || !rawLogin || !["add", "remove"].includes(action)) {
    console.log('الاستخدام: node scripts/addUser.js add|remove <login> ["note"] ["role"]');
    process.exit(1);
  }

  if (action === "add") {
    let role = rawRole;
    if (rawRole && !VALID_ROLES.includes(rawRole)) {
      console.log(`⚠️  دور غير معروف "${rawRole}"، تم استخدام "viewer" بدلاً منه.`);
      role = "viewer";
    }
    const user = await upsertUser({ login: rawLogin, role, note });
    console.log(`✅ تمت إضافة: ${user.login} (role: ${user.role})`);
  } else {
    const { login } = await removeUser(rawLogin);
    console.log(`🗑️  تم حذف: ${login}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
