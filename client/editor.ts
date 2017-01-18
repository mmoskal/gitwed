declare var ContentTools: any;
declare var ContentEdit: any;

namespace gw {
    export interface ImgResponse {
        url: string;
        thumbUrl: string;
        w: number;
        h: number;
    }

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


    function resizePicture(max: number, img: HTMLImageElement) {
        var w = img.width;
        var h = img.height;
        var scale = 1;
        if (w > h) {
            if (w > max) {
                scale = max / w;
                w = max;
                h = Math.floor(scale * h);
            }
        } else {
            if (h > max) {
                scale = max / h;
                h = max;
                w = Math.floor(scale * w);
            }
        }

        var canvasJQ = $("<canvas/>");
        var canvas = canvasJQ[0] as HTMLCanvasElement;
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, w, h);
        var r = canvas.toDataURL("image/jpeg", 0.85);
        return { src: r.replace(/^[^,]*,/, ""), w, h }
    }


    function postImgFileAsync(fileObj: File, maxSize = 1000) {
        let reader = new FileReader();

        return new Promise<ImgResponse>((resolve, reject) => {
            reader.onload = (event) => {
                let img = new Image();
                img.onload = () => {
                    let thumbnail = resizePicture(200, img).src;
                    let fullimg = img.src
                    let format = ""
                    let w = img.width
                    let h = img.height
                    if (img.width > maxSize || img.height > maxSize) {
                        let r = resizePicture(maxSize, img)
                        w = r.w
                        h = r.h
                        fullimg = r.src
                        format = "jpg"
                    } else {
                        if (/^data:image\/png/.test(fullimg)) format = "png"
                        else format = "jpg"
                        fullimg = fullimg.replace(/^[^,]*,/, "");
                    }

                    postJsonAsync("/api/uploadimg", {
                        page: document.location.pathname,
                        full: fullimg,
                        thumb: thumbnail,
                        filename: fileObj.name,
                        format: format,
                    }).then((v: ImgResponse) => {
                        v.w = w
                        v.h = h
                        resolve(v)
                    }, reject)
                }
                img.src = (event.target as any).result;
            }
            reader.readAsDataURL(fileObj);
        })
    }

    function imgUploader(dialog: any) {
        dialog.addEventListener('imageuploader.cancelupload', () => {
            // Set the dialog to empty
            dialog.state('empty');
        });

        dialog.addEventListener('imageuploader.fileready', (ev: any) => {
            // Upload a file to the server
            let formData;
            let file = ev.detail().file;

            // Set the dialog state to uploading and reset the progress bar to 0
            dialog.state('uploading');
            dialog.progress(0);

            postImgFileAsync(file)
                .then(resp => {
                    dialog.save(
                        resp.url,
                        [resp.w, resp.h],
                        {
                            'alt': file.name,
                            'data-ce-max-width': resp.w
                        });
                })
        });
    }

    $(window).on("load", () => {
        let editor: any
        ContentTools.StylePalette.add([
            new ContentTools.Style('Author', 'author', ['p'])
        ])
        editor = ContentTools.EditorApp.get()
        editor.init('[data-editable], [data-fixture]', 'data-gw-id')

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

        ContentTools.IMAGE_UPLOADER = imgUploader;

    })

    window.addEventListener("unhandledrejection", (e: any) => {
        // NOTE: e.preventDefault() must be manually called to prevent the default
        // action which is currently to log the stack trace to console.warn
        // e.preventDefault();

        new ContentTools.FlashUI('no');

        // var reason = e.detail.reason;
        // var promise = e.detail.promise;
        // See Promise.onPossiblyUnhandledRejection for parameter documentation
    });


}