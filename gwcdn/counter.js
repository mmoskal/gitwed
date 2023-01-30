window.addEventListener("load", () => {
    function e(id) {
        return document.getElementById(id)
    }

    const cntVal = e("cnt-val")
    const cntNum = e("cnt-num")
    const cntPass = e("cnt-pass")
    const cntSubmit = e("cnt-submit")

    const path = window.location.pathname
    const key =
        "count_pass_" +
        path
            .slice(1)
            .replace(/\/.*/, "")
            .replace(/[^a-z0-9]+/g, "_")

    cntNum.max = +cntVal.getAttribute("data-max-count")
    let target = +cntVal.textContent

    if (localStorage[key]) cntPass.value = localStorage[key]

    let currNum = 0
    function update() {
        let delta = target - currNum
        if (delta == 0) return
        let d = Math.round(delta * 0.4) + 1
        d = Math.min(delta, d)
        currNum += d
        cntVal.textContent = "" + currNum
        setTimeout(update, 60)
    }
    update()

    const errors = {
        403: "Invalid password",
        405: "Counter not set up",
        412: "Count limit exceeded",
        429: "Submitting too often",
        400: "Invalid request",
    }

    cntSubmit.onclick = async ev => {
        ev.preventDefault()
        const count = +cntNum.value
        if (!count || count <= 0) return

        const password = cntPass?.value

        cntSubmit.disabled = true
        const resp = await fetch("/api/post-count", {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                path,
                count,
                from: "",
                comment: "",
                password,
            }),
        })
        if (resp.status == 200) {
            if (password) {
                localStorage[key] = password
            }
            cntNum.value = ""
            cntSubmit.disabled = false
            const j = await resp.json()
            console.log(j)
            if (j.count) {
                target = j.count
                update()
            }
        } else {
            cntSubmit.disabled = false
            const err = errors[resp.status + ""] ?? `HTTP ${resp.status}`
            e("err-msg").textContent = err
        }
    }
})
