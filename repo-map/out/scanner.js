"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanRepository = scanRepository;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function categorizeLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
        return "normal";
    }
    if (trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("'''") ||
        trimmed.startsWith("\"\"\"")) {
        return "comment";
    }
    if (trimmed.startsWith("import ") ||
        trimmed.startsWith("export ") ||
        trimmed.startsWith("from ") ||
        trimmed.startsWith("using ") ||
        trimmed.includes("require(")) {
        return "import";
    }
    if (trimmed.startsWith("class ") ||
        trimmed.startsWith("interface ") ||
        trimmed.startsWith("struct ") ||
        trimmed.startsWith("impl ") ||
        trimmed.startsWith("type ")) {
        return "class";
    }
    if (trimmed.startsWith("function ") ||
        trimmed.startsWith("def ") ||
        trimmed.startsWith("fn ") ||
        trimmed.startsWith("func ")) {
        return "function";
    }
    if (trimmed.includes("if ") ||
        trimmed.includes("for ") ||
        trimmed.includes("while ") ||
        trimmed.includes("return") ||
        trimmed.includes("switch") ||
        trimmed.includes("else") ||
        trimmed.includes("elif") ||
        trimmed.includes("catch") ||
        trimmed.includes("try")) {
        return "control-flow";
    }
    return "normal";
}
function shouldIgnore(relativePath, rules) {
    const pathStr = relativePath.replace(/\\/g, "/");
    for (const rule of rules) {
        const ruleStr = rule.replace(/\\/g, "/");
        const isDirRule = ruleStr.endsWith("/");
        const cleanRule = isDirRule ? ruleStr.slice(0, -1) : ruleStr;
        let regexPattern = cleanRule
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        if (cleanRule.startsWith("/")) {
            regexPattern = "^" + regexPattern.slice(1);
        }
        else {
            regexPattern = "(^|/)" + regexPattern;
        }
        if (isDirRule) {
            regexPattern = regexPattern + "(/|$)";
        }
        else {
            regexPattern = regexPattern + "($|/)";
        }
        try {
            const rx = new RegExp(regexPattern);
            if (rx.test(pathStr)) {
                return true;
            }
        }
        catch {
            if (pathStr.includes(cleanRule)) {
                return true;
            }
        }
    }
    return false;
}
async function scanRepository() {
    // Scan all files but exclude non-code or build folders
    const files = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,build,out,target,coverage,venv,.venv}/**");
    let gitignoreRules = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const gitignorePath = path.join(workspaceFolders[0].uri.fsPath, ".gitignore");
        if (fs.existsSync(gitignorePath)) {
            try {
                const content = fs.readFileSync(gitignorePath, "utf-8");
                gitignoreRules = content
                    .split("\n")
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith("#"));
            }
            catch {
            }
        }
    }
    const result = [];
    for (const file of files) {
        const relative = vscode.workspace.asRelativePath(file);
        if (shouldIgnore(relative, gitignoreRules)) {
            continue;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(file);
            if (doc.lineCount === 0) {
                continue;
            }
            const rawLines = [];
            for (let i = 0; i < doc.lineCount; i++) {
                const textLine = doc.lineAt(i).text;
                const trimmedRight = textLine.trimEnd();
                const indent = textLine.length - textLine.trimStart().length;
                const len = trimmedRight.length;
                rawLines.push({
                    text: textLine,
                    indent,
                    length: len,
                    category: categorizeLine(textLine)
                });
            }
            result.push({
                id: file.fsPath,
                path: vscode.workspace.asRelativePath(file),
                uri: file.toString(),
                lines: rawLines,
                lineCount: doc.lineCount
            });
        }
        catch {
            // Ignore unreadable files
        }
    }
    return result;
}
//# sourceMappingURL=scanner.js.map