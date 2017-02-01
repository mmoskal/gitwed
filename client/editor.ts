declare var ContentTools: any;
declare var ContentEdit: any;
declare var gitwedPageInfo: gw.PageInfo;

namespace gw {
    let supportAutoSave = false

    export function timeAgo(tm: number) {
        var diff = (Date.now() - tm) / 1000;
        function nAgo(n: number, noun: string) {
            n = Math.round(n);
            if (n == 1) return "one " + noun + " ago";
            else return n + " " + noun + "s ago";
        }
        if (diff <= 1) return "now";
        if (diff <= 60) return nAgo(diff, "second");
        diff /= 60;
        if (diff <= 60) return nAgo(diff, "minute");
        diff /= 60;
        if (diff <= 24) return nAgo(diff, "hour");
        diff /= 24;
        if (diff <= 30) return nAgo(diff, "day");
        diff /= 30.417;
        if (diff <= 12) return nAgo(diff, "month");
        diff /= 12;
        return nAgo(diff, "year");
    }

    export interface LogEntry {
        id: string;
        author: string;
        date: number;
        files: string[];
        msg: string;
    }

    export interface PageInfo {
        user: string;
        lang: string;
        langFileCreated: boolean;
        availableLangs: string[];
        isDefaultLang: boolean;
        path: string;
        ref: string;
        isEditable: boolean;
    }

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

    export function getJsonAsync(path: string) {
        return httpRequestAsync({ url: path })
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
        if (!gitwedPageInfo.isEditable)
            return

        let metasection = $("#gw-meta-section")
        metasection.css("display", "block")
        metasection.prepend("<div class=gw-label>meta-information (only visible to editors)</div>")
        metasection.children().each((idx, e) => {
            let ee = $(e)
            let m = /gw-meta-(.*)/.exec(ee.attr("id"))
            if (m) {
                ee.before("<div class=gw-label>" + m[1] + ":</div>")
            }
        })

        let msgbox = $("<div id='ct-msgbox'></div>").text("Editing " + gitwedPageInfo.lang)

        ContentEdit.TagNames.get().register(ContentEdit.Text, 'address', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'a', 'span', 'li');

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
                    lang: gitwedPageInfo.isDefaultLang ? null : gitwedPageInfo.lang,
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

        if (supportAutoSave) {
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
        }


        let moreBtn = $("<div class='ct-ignition__button ct-ignition__button--more'></div>")
        moreBtn.click(() => {
            let modal = new ContentTools.ModalUI()
            let dialog = new ContentTools.DialogUI('GitWED options')
            let app = ContentTools.EditorApp.get()
            app.attach(modal)
            app.attach(dialog)
            modal.show()
            dialog.show()
            $(dialog._domElement).addClass("ct-history-dialog");

            let root = $(dialog._domView)
            let status = (msg: string) => {
                root.empty()
                root.append(msg)
            }

            let currPath = document.location.pathname
            root.append(
                `
<p>
Logged in as ${gitwedPageInfo.user}. 
<a href="/gw/logout?redirect=${encodeURIComponent(location.pathname)}">Logout</a> <br>
Content language: ${gitwedPageInfo.lang} ${gitwedPageInfo.isDefaultLang ? "(default)" : ""} <br>
All languages: ${gitwedPageInfo.availableLangs.map(l =>
                    `<a href="${currPath}?setlang=${l}">${l}</a>`).join(" ")}
</p>
`)

            let hist = $("<button>Show page history</button>")
            hist.click(() => {
                status("Loading...")
                getJsonAsync("/api/history?path=" + encodeURIComponent(currPath.replace(/\/[^\/]+$/, "")))
                    .then((data: LogEntry[]) => {
                        let ch: JQuery[] = []
                        for (let e of data) {
                            let lnk = $("<a target=_blank></a>")
                            lnk.attr("href", "/" + e.id + document.location.pathname)
                            lnk.text(timeAgo(e.date * 1000))
                            let ent = $("<div class='ct-history-entry'></div>")
                                .append(lnk)
                                .append(" ")
                                .append($("<span class='ct-msg'></span>").text(e.msg + " by " + e.author))
                            ch.push(ent)
                        }
                        $(dialog._domView).empty().append(ch)
                    })

            })
            root.append(hist)

            let invite = $("<button>Invite someone to edit</button>")
            invite.click(() => {
                root.empty()
                let dir = "/" + currPath.slice(1).replace(/\/.*/, "")
                root.append(`The person you're inviting will be able to edit the website under <strong>${dir}</strong>.<br>
                Their email: `)
                let inp = $("<input type=email>")
                let sub = $("<button>Send invite</button>")
                root.append(inp).append(" ").append(sub)
                sub.click(() => {
                    let e = inp.val() || ""
                    e = e.trim()
                    if (!/^\S+@\S+/.test(e)) {
                        root.append("Invalid email")
                        return
                    }

                    status("Inviting...")

                    postJsonAsync("/api/invite", {
                        path: currPath,
                        email: e
                    })
                        .then(res => {
                            status("User invited.")
                        }, err => {
                            status("Sorry. It didn't work out.")
                        })
                })
            })
            root.append(invite)

            $(dialog._domClose).click(() => {
                modal.hide()
                dialog.hide()
            })

        })
        $(".ct-ignition").append(moreBtn).append(msgbox)

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