/// <reference path="../typings/globals/jquery/index.d.ts" />

declare var ContentTools: any;

$(window).on("load", () => {
    let editor:any
    ContentTools.StylePalette.add([
        new ContentTools.Style('Author', 'author', ['p'])
    ])
    editor = ContentTools.EditorApp.get()
    editor.init('*[data-editable]', 'id')
})