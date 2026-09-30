// The extension host's page and handler source as one string (extension.ts plus modules split out
// of it), for tests that check host code or the webview page markup by text.
const fs = require("fs");
const path = require("path");

const HOST_FILES = ["extension.ts", "webview_html.ts", "file_actions.ts", "settings_actions.ts"];

function readHostSource() {
    return HOST_FILES.map(file => fs.readFileSync(path.join(__dirname, "..", "..", file), "utf8")).join("\n");
}

module.exports = { readHostSource };
