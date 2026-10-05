// Matches workspace-relative paths against Thumbview ignore patterns (gitignore-like globs with
// "!" negation and the "(root files)" pseudo-pattern). Returns whether a path is ignored.
// Compiled once per rule string: shouldIgnore runs for every file against every rule on each scan,
// payload, and ignore-count pass, and recompiling there dominated large-repo scans.
const compiledRules = new Map<string, RegExp | null>();

function compileRule(rule: string): RegExp | null {
    const ruleStr = rule.replace(/\\/g, "/");
    const isDirRule = ruleStr.endsWith("/");
    const cleanRule = isDirRule ? ruleStr.slice(0, -1) : ruleStr;

    let regexPattern = cleanRule
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');

    if (cleanRule.startsWith("/")) {
        regexPattern = "^" + regexPattern.slice(1);
    } else {
        regexPattern = "(^|/)" + regexPattern;
    }

    if (isDirRule) {
        regexPattern = regexPattern + "(/|$)";
    } else {
        regexPattern = regexPattern + "($|/)";
    }

    try {
        return new RegExp(regexPattern);
    } catch {
        return null;
    }
}

function matchSingleRule(pathStr: string, rule: string): boolean {
    let rx = compiledRules.get(rule);
    if (rx === undefined) {
        rx = compileRule(rule);
        compiledRules.set(rule, rx);
    }
    if (rx) {
        return rx.test(pathStr);
    }
    const ruleStr = rule.replace(/\\/g, "/");
    return pathStr.includes(ruleStr.endsWith("/") ? ruleStr.slice(0, -1) : ruleStr);
}

// Hand-rolled gitignore-glob-to-regex translator (falls back to a plain substring
// match if the generated pattern fails to compile). Evaluates rules sequentially
// in order and supports negation patterns ("!foo") to un-ignore files.
export function shouldIgnore(relativePath: string, rules: string[]): boolean {
    const pathStr = relativePath.replace(/\\/g, "/");
    let ignored = false;

    for (const rule of rules) {
        if (!rule) continue;
        const isNegated = rule.startsWith("!");
        const pattern = isNegated ? rule.slice(1).trim() : rule.trim();
        if (!pattern) continue;

        const cleanPattern = pattern.replace(/^\/+|\/+$/g, "");
        if (cleanPattern === "(root files)") {
            if (!pathStr.includes("/")) {
                ignored = !isNegated;
            }
        } else if (matchSingleRule(pathStr, pattern)) {
            ignored = !isNegated;
        }
    }

    return ignored;
}
