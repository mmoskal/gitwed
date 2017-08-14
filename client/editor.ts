declare var ContentTools: any;
declare var ContentEdit: any;
declare var ContentSelect: any;
declare var gitwedPageInfo: gw.PageInfo;

type SMap<T> = { [s: string]: T };

namespace gw {
    let maxImgSize = 1000
    let blobData: SMap<{ dataURL: string; serverURL: string; }> = {}

    function htmlQuote(s: string) {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    }

    function delay(ms: number): Promise<void> {
        return (Promise as any).delay(ms)
    }

    function __ct_extends(child: any, parent: any) {
        const __hasProp = {}.hasOwnProperty;
        for (var key in parent) {
            if (__hasProp.call(parent, key)) child[key] = parent[key];
        }
        function ctor() { this.constructor = child; }
        ctor.prototype = parent.prototype;
        child.prototype = new (ctor as any)();
        child.__super__ = parent.prototype;
        return child;
    }

    function mkTool(tag: string, icon: string = "", isInline = false) {
        let Tool: any = function () {
            return Tool.__super__.constructor.apply(this, arguments);
        }

        __ct_extends(Tool, isInline ? ContentTools.Tools.Bold : ContentTools.Tools.Heading);

        ContentTools.ToolShelf.stow(Tool, tag);

        Tool.label = tag;
        Tool.icon = icon || tag;
        Tool.tagName = tag;

        return Tool;
    }

    for (let i = 1; i <= 6; i++) mkTool("h" + i)
    mkTool("blockquote")
    mkTool("figcaption")
    mkTool("sup", "", true)

    const fullTools = [
        ['bold', 'italic', 'link', 'sup', 'align-left', 'align-center', 'align-right'],
        ['h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'paragraph', 'unordered-list', 'ordered-list',
            'blockquote', 'figcaption',
            'table', 'indent', 'unindent', 'line-break'],
        ['image', 'video', 'preformatted'],
        ['undo', 'redo', 'remove']
    ]
    const fixtureTools = [
        ['undo', 'redo', 'remove']
    ]

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

    export interface EventInfo {
        id: number;
        center: string;
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
        eventInfo: EventInfo;
        center: string;
        epub: boolean;
    }

    export interface ImgResponse {
        url: string;
        w: number;
        h: number;
    }

    export interface RequestOptions {
        method?: string;
        url: string;
        data?: string;
    }

    export interface TocProps {
        title: string;
        author: string;
        image: string;
        href: string;
        flags: string;
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
                    let msg = err || status
                    try {
                        let j = JSON.parse(jq.responseText)
                        if (j.error) msg = j.error
                    } catch (e) { }
                    reject(new Error(msg))
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


    function copyMissing(trg: any, src: any) {
        for (let k of Object.keys(src)) {
            if (!trg.hasOwnProperty(k))
                trg[k] = src[k]
        }
    }

    function copyAll(trg: any, src: any) {
        for (let k of Object.keys(src)) {
            trg[k] = src[k]
        }
    }

    function extractPrefixed(pref: string, regions: SMap<string>) {
        let ret: SMap<string> = {}
        let num = 0
        for (let k of Object.keys(regions)) {
            let idx = k.indexOf(pref)
            if (idx < 0) continue
            let m = k.slice(idx + pref.length)
            ret[m] = regions[k]
            delete regions[k]
            num++
        }
        if (!num) return null
        ret["_lang"] = gitwedPageInfo.lang
        return ret
    }

    function parseDataUri(dataUri: string) {
        let s = dataUri.split(',')
        let m = /^data:([^;]+)/.exec(s[0])
        return {
            b64: s[1],
            mime: m[1],
            ext: m[1] == "image/png" ? "png" :
                m[1] == "image/jpeg" ? "jpg" : "???"
        }
    }

    function constrainSize(w: number, h: number, maxW: number, maxH: number) {
        let scale = Math.min(maxW / w, maxH / h)
        if (scale < 1) {
            w = Math.floor(scale * w)
            h = Math.floor(scale * h)
        }
        return {
            w,
            h
        }
    }

    function dataUriToBlob(url: string) {
        let u = parseDataUri(url)
        let b64 = atob(u.b64)
        let arr = new Uint8Array(b64.length)
        for (let i = 0; i < b64.length; ++i)
            arr[i] = b64.charCodeAt(i)
        return new Blob([arr.buffer], { type: u.mime });
    }

    function resizePicture(maxW: number, maxH: number, img: HTMLImageElement): ImgResponse {
        let sz = constrainSize(img.width, img.height, maxW, maxH)
        let w = sz.w
        let h = sz.h
        let isJpeg = /^data:image\/jpeg/.test(img.src)
        // don't allow largish PNG (likely from copy&paste), or very large JPG files
        let isOK = (isJpeg && img.src.length < 3000000) || img.src.length < 50000
        if (w == img.width && isOK) {
            return {
                url: img.src,
                w,
                h
            }
        }

        var canvasJQ = $("<canvas/>");
        var canvas = canvasJQ[0] as HTMLCanvasElement;
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, w, h);
        var r = canvas.toDataURL("image/jpeg", 0.85);
        return { url: r, w, h }
    }

    function resizeFileAsync(fileObj: File, maxWidth: number, maxHeight: number) {
        let reader = new FileReader();

        return new Promise<ImgResponse>((resolve, reject) => {
            reader.onload = (event) => {
                let img = new Image();
                img.onload = () => {
                    resolve(resizePicture(maxWidth, maxHeight, img))
                }
                img.src = (event.target as any).result;
            }
            reader.readAsDataURL(fileObj);
        })

    }

    function postImageUrlAsync(url: string, name: string) {
        let u = parseDataUri(url)
        return postJsonAsync("/api/uploadimg", {
            page: document.location.pathname,
            full: u.b64,
            filename: name,
            format: u.ext,
        })
            .then((v: ImgResponse) => v)
    }

    function postImgFileAsync(fileObj: File, max: number) {
        return resizeFileAsync(fileObj, max, max)
            .then(img => postImageUrlAsync(img.url, fileObj.name)
                .then((v: ImgResponse) => {
                    v.w = img.w
                    v.h = img.h
                    return v
                }))
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

            postImgFileAsync(file, maxImgSize)
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


    function stopEvent(e: JQueryEventObject) {
        e.preventDefault();
        e.stopPropagation();
    }

    function setDropClass(t: JQuery) {
        t.on("dragenter", function (e) {
            stopEvent(e);
            t.addClass('gw-drag');
        });
        t.on("dragleave", function (e) {
            t.removeClass('gw-drag');
        });
        t.on("dragover", function (e) {
            stopEvent(e);
            t.addClass('gw-drag');
        });
    }


    function editImages() {
        let imgs = $("#gw-img-edit-cont")
        imgs.empty()
        imgs.html("<h2>Image replacement</h2>" +
            "<p>Drag and drop any image you want over one of these below to replace it. " +
            "You can then choose upload resolution and see how it looks like in the site. " +
            "After that, you can hit the upload button. " +
            "Once you do, to go back to the previous picture you will have to upload it again." +
            "</p>")
        $("img").each((idx, e) => handleElement(e, "src"))
        $("*[data-background]").each((idx, e) => handleElement(e, "data-background"))

        function handleElement(e_: Element, attrname: string) {
            let elt = $(e_)
            let orig = elt.attr("data-gw-orig-" + attrname) || elt.attr(attrname)
            if (!orig || !/\.(jpe?g|png)$/.exec(orig))
                return;
            if (/^https?:/.test(orig))
                return;
            let imgSrc = elt.attr(attrname)
            let img = $("<img>")
            let label = $("<div class='gw-label'></div>")
            let origLoaded = false
            let w = 0
            let h = 0
            let lastFile: File = null
            let currData = ""
            img.attr("src", imgSrc)
            let formCont = $("<div></div>")
            img.on("load", () => {
                let i = img[0] as any
                let wn = i.naturalWidth
                let hn = i.naturalHeight
                if (!origLoaded) {
                    origLoaded = true
                    w = wn
                    h = hn
                    label.text("  " + w + "x" + h + "px")
                    let dl = $("<a class='img-dl'></a>")
                    dl.text(orig)
                    dl.attr("href", imgSrc)
                    dl.attr("download", orig.replace(/.*\//, ""))
                    label.prepend(dl)
                    label.prepend(formCont)
                } else {
                    // new pic
                    let p = Promise.resolve()
                    let options: SMap<{ url: string, size: number }> = {}
                    let addOption = (mw: number, mh: number) => {
                        let sz = constrainSize(wn, hn, mw, mh)
                        let k = sz.w + "x" + sz.h
                        p = p
                            .then(() => {
                                if (options[k])
                                    return null
                                return resizeFileAsync(lastFile, mw, mh)
                            })
                            .then(img => {
                                if (!img) return
                                let size = Math.round((img.url.length * 3 / 4) / 1024)
                                if (size > 600)
                                    img.url = "NONE"
                                options[k] = { url: img.url, size }
                            })
                    }
                    addOption(w, h)
                    addOption(w, 3000)
                    addOption(3000, h)
                    addOption(1000, 1000)
                    addOption(2000, 2000)
                    addOption(10000, 10000)
                    p.then(() => {
                        let optform = $("<form action='#'></form>")
                        let ops: JQuery[] = []
                        Object.keys(options).forEach(k => {
                            let op = $("<input type='radio' name='res'></input>")
                            ops.push(op)
                            op.attr("value", k)
                            let text = " " + k + " " + options[k].size + "k"
                            if (options[k].url == "NONE") {
                                text += " (too big)"
                                op.attr("disabled", "true")
                            }
                            op.on("change", () => {
                                if ((op[0] as HTMLInputElement).checked) {
                                    currData = options[k].url
                                    setInPage(currData)
                                }
                            })
                            let lbl = $("<label></label>")
                            lbl.text(text)
                            lbl.prepend(op)
                            optform.append(lbl)
                        });

                        let upload = $("<button>Upload and replace</button>")
                        upload.click((ev) => {
                            stopEvent(ev)
                            let link = document.createElement("a");
                            link.href = orig
                            upload.attr("disabled", "true")
                            let u = parseDataUri(currData)
                            return postJsonAsync("/api/replaceimg", {
                                page: document.location.pathname,
                                filename: link.pathname,
                                full: u.b64,
                            }).then(() => {
                                formCont.empty()
                                new ContentTools.FlashUI('ok')
                            }, err => {
                                upload.removeAttr("disabled")
                            })
                        })
                        optform.append(upload)

                        formCont.empty()
                        formCont.append(optform)
                        ops[0].click()

                        outer.removeClass("gw-busy")
                    })
                }
            })
            let outer = $("<div class='gw-img-edit'></div>")
            outer.append(img)
            outer.append(label)

            setDropClass(outer)
            outer.on("drop", function (e) {
                let de = e.originalEvent as DragEvent
                if (de.dataTransfer) {
                    if (de.dataTransfer.files.length) {
                        stopEvent(e);
                        lastFile = de.dataTransfer.files[0]
                        let url = URL.createObjectURL(lastFile)
                        outer.addClass("gw-busy")
                        img.attr("src", url)
                    }
                }
            });

            imgs.append(outer)

            let origAttrs: SMap<string> = {}
            function setInPage(url: string) {
                if (attrname != "src")
                    $.each(elt[0].attributes, function (i, attrib) {
                        if (attrib.value) {
                            if (!origAttrs[attrib.name])
                                origAttrs[attrib.name] = attrib.value
                            let n = origAttrs[attrib.name].replace(imgSrc, url)
                            if (n != origAttrs[attrib.name])
                                elt.attr(attrib.name, n)
                        }
                    });
                elt.attr(attrname, url)
            }
        }
    }

    $(window).on("load", () => {
        if (!gitwedPageInfo.isEditable)
            return

        if (gitwedPageInfo.epub)
            maxImgSize = 1600

        let evInfo = gitwedPageInfo.eventInfo

        let metasection = $("#gw-meta-section")
        if (metasection.length) {
            metasection.css("display", "block")
            metasection.prepend("<div class=gw-label>meta-information (only visible to editors)</div>")
            metasection.children().each((idx, e) => {
                let ee = $(e)
                let m = /gw-meta-(.*)/.exec(ee.attr("id"))
                if (m) {
                    ee.before("<div class=gw-label>" + m[1] + ":</div>")
                }
            })
        }

        let imgs = $("#gw-img-edit-cont")
        if (imgs.length) {
            imgs.css("display", "block")
            let b = $("<button>Edit images</button>")
            b.click(editImages)
            imgs.empty()
            imgs.append(b)
        }
        //editImages(); // TODO remove me

        let msgbox = $("<div id='ct-msgbox'></div>").text("Editing " + gitwedPageInfo.lang)

        // This is for fixture editing (i.e., text-only, non-html)
        ContentEdit.TagNames.get().register(ContentEdit.Text,
            'address', 'blockquote',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'p', 'div', 'a', 'span', 'li',
            'label', 'footer', 'section', 'figcaption');

        let editor: any
        ContentTools.StylePalette.add([
            new ContentTools.Style('Author', 'author', ['p'])
        ])

        editor = ContentTools.EditorApp.get()
        let numdisabled = 0

        if (evInfo && !/templateedit/.test(document.location.hash)) {
            $('[data-editable], [data-fixture]').each((i, e) => {
                let ee = $(e)
                if (/_ev_/.test(ee.attr("data-gw-id"))) {
                    // skip
                } else {
                    numdisabled++
                    ee.removeAttr("data-editable")
                    ee.removeAttr("data-fixture")
                }
            })
        }

        editor.init('[data-editable], [data-fixture]', 'data-gw-id')

        let failedRegions: any = {}

        editor.addEventListener('saved', (ev: any) => {
            let regions: SMap<string> = ev.detail().regions

            copyMissing(regions, failedRegions)

            if (Object.keys(regions).length == 0)
                return

            let myRegions = {}
            failedRegions = myRegions

            editor.busy(true);

            let savePromise = Promise.resolve()

            let final = () => { }

            let upd = extractPrefixed("_ev_", regions)
            if (upd) {
                let up: any = evInfo

                // for pre-exisiting events, just pass the updated data
                if (evInfo.id)
                    up = {
                        id: evInfo.id,
                        center: evInfo.center,
                    }

                copyAll(up, upd)
                savePromise = savePromise
                    .then(() => postJsonAsync("/api/events", up))
                    .then((data: any) => {
                        if (/\/new/.test(document.location.href) && data && data.id) {
                            final = () =>
                                setTimeout(() => {
                                    document.location.href = document.location.href.replace(/\/new.*/, "/" + data.id)
                                }, 100)
                        }
                    })
            }

            let centerUpd = extractPrefixed("_cnt_", regions)
            if (centerUpd) {
                centerUpd.id = gitwedPageInfo.center
                savePromise = savePromise
                    .then(() => postJsonAsync("/api/centers", centerUpd))
                    .then(() => { })
            }

            if (Object.keys(regions).length) {
                Object.keys(regions).forEach(id => {
                    let r = regions[id]
                    let r2 = r.replace(/<img\s[^<>]*src="(blob:[^"]+)/g, (f, url) => {
                        savePromise = savePromise
                            .then(() => postImageUrlAsync(blobData[url].dataURL, "clip"))
                            .then(resp => {
                                blobData[url].dataURL = ""
                                blobData[url].serverURL = resp.url
                                regions[id] = regions[id].replace(url, resp.url)
                            })
                        return "did something"
                    })
                    if (r != r2)
                        savePromise = savePromise
                            .then(() => {
                                //let toc = editor.regions()[id]
                                //toc.setContent(regions[id])
                            })
                })

                savePromise = savePromise
                    .then(() => (Promise as any).each(Object.keys(regions), (id: string) =>
                        postJsonAsync("/api/update", {
                            page: document.location.pathname,
                            lang: gitwedPageInfo.lang,
                            id: id,
                            value: regions[id]
                        })))
            }

            savePromise
                .then(() => {
                    editor.busy(false)
                    new ContentTools.FlashUI('ok')
                    $("img").each((i, e) => {
                        let ee = $(e)
                        let d = blobData[ee.attr("src")]
                        if (d && d.serverURL)
                            ee.attr("src", d.serverURL)
                    })
                    final()
                })
                .catch((e: any) => {
                    console.error(e)
                    editor.busy(false)
                    new ContentTools.FlashUI('no')
                    if (e.message)
                        alert(e.message)
                    // prevent race
                    if (failedRegions === myRegions) {
                        failedRegions = regions
                        $(".ct-ignition__button--edit").click()
                    }
                })
        });

        ContentEdit.Root.get().bind('focus', (element: any) => {
            let tools = element.isFixed() ? fixtureTools : fullTools;
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

        const blockTags: SMap<string> = {
            "p": "p",
            "h1": "h1",
            "h2": "h2",
            "h3": "h3",
            "h4": "h4",
            "h5": "h5",
            "h6": "h6",
        }

        const inlineTags: SMap<string> = {
            "strong": "b",
            "em": "i",
            "b": "b",
            "i": "i",
        }

        function pasteHTML(element: any, html: string, text: string) {
            let isBlock = false
            let cleaned = ""

            function addInline(s: string) {
                if (!s) return
                cleaned += s
            }

            function append(ee: Element) {
                if (ee.nodeType != 1) {
                    addInline(ee.textContent)
                    return
                }

                let tag = ee.tagName.toLowerCase()

                if (tag == "meta") return

                if (blockTags.hasOwnProperty(tag)) {
                    tag = blockTags[tag]
                    cleaned += `<${tag}>`
                    isBlock = true
                } else if (tag == "a") {
                    addInline(`<a href="${ee.getAttribute("href")}">`)
                } else if (inlineTags.hasOwnProperty(tag)) {
                    tag = inlineTags[tag]
                    addInline(`<${tag}>`)
                } else {
                    tag = ""
                }

                if (!tag) {
                    // style parsing
                    let st = ee.getAttribute("style")
                    if (st) {
                        if (/font-style:\s*(oblique|italic)/.test(st))
                            tag = "i"
                        if (/font-weight:\s*(bold|900|800|700)/.test(st))
                            tag = "b"
                        if (/vertical-align:\s*super/.test(st))
                            tag = "sup"
                        if (tag)
                            addInline(`<${tag}>`)
                    }
                }

                for (let i = 0; i < ee.childNodes.length; ++i)
                    append(ee.childNodes[i] as Element)

                if (tag) {
                    cleaned += `</${tag}>`
                }
            }

            let wrap0 = document.createElement('div')
            // remove word-breaks
            html = html.replace(/-<br\s*\/>/g, "")
            wrap0.innerHTML = html
            console.log("ORIG", wrap0)
            if (text === null) {
                cleaned = html
                isBlock = true
            } else {
                append(wrap0)
            }
            cleaned = cleaned.replace(/<\/b>(\s*)<b>/g, (f, x) => x)
            cleaned = cleaned.replace(/<b>(\s*)<\/b>/g, (f, x) => x)
            cleaned = cleaned.replace(/<\/i>(\s*)<i>/g, (f, x) => x)
            cleaned = cleaned.replace(/<p>\s*<\/p>/g, "")
            cleaned = cleaned.replace(/<p><b>([^<>]+)<\/b><\/p>/g, (f, x) => "<h3>" + x + "</h3>")
            console.log(cleaned)
            let wrap1 = document.createElement('div')
            wrap1.innerHTML = cleaned
            console.log("CLEAN", wrap1)

            let insertNode = element
            if (insertNode.parent().type() !== 'Region') {
                insertNode = element.closest((node: any) =>
                    node.parent() && node.parent().type() === 'Region')
            }

            if (!isBlock || !insertNode) {
                editor.paste(element, text)
                return
            }

            const insertIn = insertNode.parent();
            const insertAt = insertIn.children.indexOf(insertNode) + 1;
            let lastItem: any

            let wrapper = document.createElement('div')
            wrapper.innerHTML = cleaned

            let elts: HTMLElement[] = []
            for (let i = 0; i < wrapper.childNodes.length; ++i) {
                let c = wrapper.childNodes[i]
                if (c.nodeType == 1)
                    elts.push(c as HTMLElement)
            }


            const tagNames = ContentEdit.TagNames.get();

            let i = 0
            for (let childNode of elts) {
                let cls = tagNames.match(childNode.tagName);
                let item = cls.fromDOMElement(childNode);
                wrapper.removeChild(childNode);
                if (!item) continue
                lastItem = item;
                insertIn.attach(item, insertAt + i++);
            }

            if (lastItem) {
                lastItem.focus()
                if (lastItem.content) {
                    let lineLength = lastItem.content.length()
                    lastItem.selection(new ContentSelect.Range(lineLength, lineLength))
                }
            }
        }

        function myPaste(element: any, clip: any) {
            if (clip.files && clip.files.length) {
                editor.busy(true);
                resizeFileAsync(clip.files[0], maxImgSize, maxImgSize)
                    .then(res => {
                        let burl = window.URL.createObjectURL(dataUriToBlob(res.url))
                        blobData[burl] = { dataURL: res.url, serverURL: null }
                        editor.busy(false)
                        pasteHTML(element,
                            `<img src="${burl}" width=${res.w} height=${res.h}>`,
                            null)
                    })
                return
            }

            let html = clip.getData('text/html');
            let text = clip.getData('text/plain') || ""
            if (!html)
                editor.paste(element, text)
            else
                pasteHTML(element, html, text)
        }

        ContentEdit.Root.get().unbind('paste', editor._handleClipboardPaste);
        ContentEdit.Root.get().bind('paste', function (element: any, ev: any) {
            myPaste(element, ev.clipboardData || (window as any).clipboardData);
        });

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

            let addButton = (lbl: string, fn: () => void) => {
                let btn = $(`<button>${lbl}</button>`)
                btn.click(fn)
                root.append(btn)
            }

            addButton("Page history", () => {
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

            addButton("Force server refresh", () => {
                status("Refreshing...")
                getJsonAsync("/api/refresh?path=" + encodeURIComponent(window.location.pathname))
                    .then(() => {
                        status("Done.")
                        window.location.reload()
                    })
            })

            if (gitwedPageInfo.epub) {
                let folder = window.location.pathname.slice(1).replace(/\/.*/, "")
                addButton("Download epub", () => {
                    modal.hide()
                    dialog.hide()
                    window.location.href = "/api/epub?folder=" + encodeURIComponent(folder)
                })
                let tocTempl = $("#epub-toc-template").html()
                    .replace(/^\s*<!--/, "")
                    .replace(/-->\s*$/, "")
                
                let tocTemplNoImg = $("#epub-toc-template-no-img").html()
                    .replace(/^\s*<!--/, "")
                    .replace(/-->\s*$/, "")

                if (tocTempl) {
                    addButton("Re-do TOC", () => {
                        status("Generating...")
                        function repl(vars: any) {
                            let inner = vars["image"] ? tocTempl : tocTemplNoImg
                            return inner.replace(/@(\w+)@/g, (f, id) => htmlQuote(vars[id] || ""))
                        }
                        getJsonAsync("/api/epubtoc?folder=" + encodeURIComponent(folder))
                            .then((res: { toc: TocProps[] }) => {
                                let v = res.toc.map(repl).join("\n")
                                editor.ignition().edit()
                                let toc = editor.regions()["index_toc"]
                                toc.setContent(v)
                                modal.hide()
                                dialog.hide()
                            })
                    })
                }
            }

            if (numdisabled)
                addButton("Enable template edit", () => {
                    status("Reloading...")
                    document.location.hash = "templateedit"
                    document.location.reload()
                })

            addButton("Invite someone to edit", () => {
                root.empty()
                let dir = "/" + currPath.slice(1).replace(/\/.*/, "")
                if (evInfo)
                    dir = "/center-" + evInfo.center
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
                        path: dir,
                        email: e
                    })
                        .then(res => {
                            status("User invited.")
                        }, err => {
                            status("Sorry. It didn't work out.")
                        })
                })
            })

            if (evInfo) {
                root.append("<h3>Event management</h3>")
                let cloneUrl = "/events/new?clone=" + evInfo.id
                addButton("Clone in same center", () => {
                    status("Cloning...")
                    window.location.href = cloneUrl + "&center=" + evInfo.center
                })
                addButton("Clone in other center", () => {
                    status("Cloning...")
                    window.location.href = cloneUrl
                })
            }


            $(dialog._domClose).click(() => {
                modal.hide()
                dialog.hide()
            })

        })
        $(".ct-ignition").append(moreBtn).append(msgbox)

        ContentTools.IMAGE_UPLOADER = imgUploader;

        if (evInfo && !evInfo.id) {
            setTimeout(() => {
                $(".ct-ignition__button--edit").click()
            }, 100)
        }
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