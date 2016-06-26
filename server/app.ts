/// <reference path="../typings/index.d.ts" />

import express = require('express');
import expander = require('./expander')

var app = express();

app.get('/', function (req, res) {
  res.send('Hello World!');
});

//app.listen(3000);

expander.test()