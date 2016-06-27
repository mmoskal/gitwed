/// <reference path="../typings/globals/jquery/index.d.ts" />
/// <reference path="../typings/globals/bluebird/index.d.ts" />

declare var ContentTools: any;

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
        editor.init('*[data-editable]', 'id')

        editor.addEventListener('saved', (ev: any) => {
            let regions = ev.detail().regions
            if (Object.keys(regions).length == 0)
                return

            editor.busy(true);

            Promise.each(Object.keys(regions), (id) =>
                postJsonAsync("/api/update", {
                    page: document.location.pathname,
                    id: id,
                    value: regions[id]
                }))
                .then(() => {
                    editor.busy(false)
                    new ContentTools.FlashUI('ok')
                })
                .catch(e => {
                    console.error(e)
                    editor.busy(false)
                    new ContentTools.FlashUI('no')
                })
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