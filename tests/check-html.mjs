import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const files = ["index.html", "admin.html", "partner.html"];
let failures = 0;
for (const file of files) {
  const html = readFileSync(resolve(file), "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!scripts.length) {
    console.error(file + ": no inline scripts found");
    failures++;
    continue;
  }
  for (let i = 0; i < scripts.length; i++) {
    try { new Function(scripts[i][1]); }
    catch (error) {
      console.error(file + " inline script " + (i + 1) + ": " + error.message);
      failures++;
    }
  }
}
if (failures) process.exit(1);
console.log("Inline JavaScript syntax OK in " + files.join(", "));
