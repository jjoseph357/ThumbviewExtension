const vscode = acquireVsCodeApi();

const canvas =
    document.getElementById("map");

const ctx =
    canvas.getContext("2d");

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

let data = null;

window.addEventListener("message", e => {

    const msg = e.data;

    if (msg.command === "data") {

        data = msg;

        render();
    }

});

function drawMinimap(
    file,
    x,
    y,
    w,
    h
) {

    ctx.fillStyle = "#202020";

    ctx.fillRect(
        x,
        y,
        w,
        h
    );

    const lines =
        file.content.split("\n");

    const stepY =
        h / Math.max(
            lines.length,
            1
        );

    ctx.fillStyle = "#58a6ff";

    for (let i = 0; i < lines.length; i++) {

        const len =
            Math.min(
                lines[i].length,
                150
            );

        const width =
            (len / 150) * w;

        ctx.fillRect(
            x,
            y + i * stepY,
            width,
            Math.max(stepY, 1)
        );
    }
}

function render() {

    ctx.clearRect(
        0,
        0,
        canvas.width,
        canvas.height
    );

    const cols = data.layout.cols;

    const rows = data.layout.rows;

    const cellW =
        canvas.width / cols;

    const cellH =
        canvas.height / rows;

    for (
        let i = 0;
        i < data.files.length;
        i++
    ) {

        const file =
            data.files[i];

        const slot =
            data.layout.slots[i];

        const col = slot[0];
        const row = slot[1];

        const x =
            col * cellW;

        const y =
            row * cellH;

        drawMinimap(
            file,
            x + 4,
            y + 18,
            cellW - 8,
            cellH - 22
        );

        ctx.fillStyle = "white";

        ctx.font = "10px sans-serif";

        ctx.fillText(
            file.path,
            x + 3,
            y + 12
        );

        file._cell = {
            x,
            y,
            w: cellW,
            h: cellH
        };
    }
}

canvas.addEventListener(
    "click",
    e => {

        const rect =
            canvas.getBoundingClientRect();

        const px =
            e.clientX - rect.left;

        const py =
            e.clientY - rect.top;

        for (const file of data.files) {

            const c = file._cell;

            if (
                px >= c.x &&
                px <= c.x + c.w &&
                py >= c.y &&
                py <= c.y + c.h
            ) {

                const relativeY =
                    (py - c.y) / c.h;

                const line =
                    Math.floor(
                        relativeY *
                        file.lines
                    );

                vscode.postMessage({
                    command: "jump",
                    uri: file.uri,
                    line
                });

                break;
            }
        }
    }
);

vscode.postMessage({
    command: "ready"
});