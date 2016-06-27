/// <reference path="../typings/index.d.ts" />

import express = require('express');
import expander = require('./expander')
import fs = require("fs")

var app = express();

app.get('/', (req, res) => {
  res.redirect("/index")
})

app.get(/^\/\w+$/, (req, res, next) => {
  if (!fs.existsSync("html" + req.path + ".html")) next();
  else {
    expander.expandFileAsync(req.path.slice(1) + ".html")
      .then(page => {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf8'
        })
        res.end(page.html)
      })
      .catch(next)
  }
})

app.use("/gw", express.static("built/gw"))
app.use("/gw", express.static("gw"))
app.use("/gw", express.static("node_modules/ContentTools/build"))

app.use((req, res) => {
  res.status(404).send('Page not found');
})

app.use((error:any, req:express.Request, res:express.Response, next:express.NextFunction) => {
  console.log(error.stack)
  res.status(500).send('Internal Server Error, ' + error.stack);
})

app.listen(3000)

//expander.test()