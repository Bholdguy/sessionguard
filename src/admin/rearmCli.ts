/** `npm run rearm` — hit the local admin re-arm endpoint (PRD Step 10). */
const port = process.env["SESSIONGUARD_ADMIN_PORT"] ?? "8789";
const token = process.env["SESSIONGUARD_ADMIN_TOKEN"] ?? "change-me-local-only";
const res = await fetch(`http://127.0.0.1:${port}/admin/rearm`, {
  method: "POST",
  headers: { "x-admin-token": token },
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
