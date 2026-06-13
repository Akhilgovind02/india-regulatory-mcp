import { readFileSync, writeFileSync } from "fs";
const f = "dist/index.js";
const c = readFileSync(f, "utf8");
if (!c.startsWith("#!")) writeFileSync(f, "#!/usr/bin/env node\n" + c);
console.log("shebang added to dist/index.js");
