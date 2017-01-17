declare var ContentTools: any;
declare var ContentEdit: any;

namespace gw {

    export interface RequestOptions {
        method?: string;
        url: string;
        data?: string;
    }

    export function httpRequestAsync(opts: RequestOptions) {
        return new Promise((resolve, reject) => {
            $.ajax({
                method: opts.method || "GET",
                url: opts.url,
                data: opts.data ? JSON.stringify(opts.data) : undefined,
                contentType: opts.data ? "application/json; charset=utf8" : undefined,
                success: (data, status, jq) => {
                    resolve(data)
                },
                error: (jq, status, err) => {
                    reject(new Error(err || status))
                }
            })
        })

    }
    export function postJsonAsync(path: string, data: any) {
        return httpRequestAsync({ url: path, data: data, method: "POST" })
    }

    $(window).on("load", () => {
        let editor: any
        ContentTools.StylePalette.add([
            new ContentTools.Style('Author', 'author', ['p'])
        ])
        editor = ContentTools.EditorApp.get()
        editor.init('[data-editable], [data-fixture]', 'id')

        editor.addEventListener('saved', (ev: any) => {
            let regions = ev.detail().regions
            if (Object.keys(regions).length == 0)
                return

            editor.busy(true);

            (Promise as any).each(Object.keys(regions), (id: string) =>
                postJsonAsync("/api/update", {
                    page: document.location.pathname,
                    id: id,
                    value: regions[id]
                }))
                .then(() => {
                    editor.busy(false)
                    new ContentTools.FlashUI('ok')
                })
                .catch((e: any) => {
                    console.error(e)
                    editor.busy(false)
                    new ContentTools.FlashUI('no')
                })
        });

        let FIXTURE_TOOLS = [['undo', 'redo', 'remove']];
        ContentEdit.Root.get().bind('focus', (element: any) => {
            let tools = element.isFixed() ? FIXTURE_TOOLS : ContentTools.DEFAULT_TOOLS;
            if (editor.toolbox().tools() !== tools) {
                return editor.toolbox().tools(tools);
            }
        });

        let autoSaveTimer = -1

        // Add support for auto-save
        editor.addEventListener('start', () => {
            autoSaveTimer = setInterval(() => {
                editor.save(true)
            }, 30 * 1000);
        });

        editor.addEventListener('stop', () => {
            clearInterval(autoSaveTimer);
        });

    })

}