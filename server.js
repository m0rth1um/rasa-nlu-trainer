#! /usr/bin/env node

// @flow
const path = require('path')
const express = require('express')
const bodyParser = require('body-parser')
const app = express()
app.use(bodyParser.json({ limit: '50mb' }))
const findit = require('findit')
const getPort = require('get-port')
const open = require('open')
const http = require("http")

const updateNotifier = require('update-notifier')
const pkg = require('./package.json')

updateNotifier({
  pkg,
  updateCheckInterval: 1000 * 60 * 60 * 24 // one day
}).notify()

const fs = require('fs')
const argv = require('yargs')
  .usage('This is my awesome program\n\nUsage: $0 [options]')
  .help('help').alias('help', 'h')
  .options({
    source: {
      alias: 's',
      description: '<filename> A json file in native rasa-nlu format',
      requiresArg: true,
    },
    port: {
      alias: 'p',
      description: '<port> Port to listen on',
      requiresArg: true,
    },
    token: {
      alias: 't',
      description: '<token> Token to use for webhooks',
      requiresArg: true
    },
    development: {
      alias: 'd',
    }
  })
  .default({
    source: null,
    port: null,
    development: false,
    token: null
  })
  .argv

const sourceFile = {
  path: '',
  data: {},
  isLoaded: false,
}

function readData(path) {
  return new Promise((resolve, reject) => {
    fs.readFile(path, 'utf8', (error, raw) => {
      let json

      if (error) {
        return reject(`Can't read file "${path}"\n${error}`)
      }

      try {
        json = JSON.parse(raw)
      }
      catch (error) {
        return reject(`Can't parse json file "${path}"\n${error}`)
      }

      if (!json.rasa_nlu_data) {
        return reject('"rasa_nlu_data" is undefined')
      }

      resolve(json)
    })
  })
}

function triggerWebhook(path) {
  return new Promise((resolve, reject) => {
    let postData = ''
    let token = argv.token
    let postOptions = {
      host: 'localhost',
      port: 5002,
      path: path + '?verify_token=' + token,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }

    let postReq = http.request(postOptions, function(res) {
      res.setEncoding('utf8')
      res.on('data', function(chunk) {
        resolve(chunk)
      })
    })

    postReq.write(postData)
    postReq.end()
    postReq.on('error', function(e) {
      console.log('Error: ' + e)
      reject(e)
    })
  })
}

if (argv.source) {
  readData(argv.source)
    .then(data => {
      sourceFile.data = data,
      sourceFile.path = argv.source
      sourceFile.isLoaded = true
      serve()
    })
    .catch(error => {
      throw error
    })
}
else {
  console.log('searching for the training examples...')
  let isSearchingOver = false
  let inReading = 0

  function checkDone() {
    if (isSearchingOver && inReading === 0) {
      if (!sourceFile.isLoaded) {
        throw new Error(`Can't find training file, please try to specify it with the --source option`)
      }
      else {
        serve()
      }
    }
  }

  const finder = findit(process.cwd())
  finder.on('directory', function (dir, stat, stop) {
    var base = path.basename(dir)
    if (base === '.git' || base === 'node_modules') stop()
  })

  finder.on('file', function (file) {
    if (file.substr(-5) === '.json' && !sourceFile.isLoaded) {

      inReading++
      readData(file)
        .then(data => {
          if (!sourceFile.isLoaded) { // an other file could have been loaded in the meantime
            sourceFile.data = data,
            sourceFile.path = file
            sourceFile.isLoaded = true
            console.log(`found ${file}`)
          }
        })
        .catch(() => {})
        .then(() => {
          inReading--
          checkDone()
        })
    }
  })

  finder.on('end', function () {
    isSearchingOver = true
    checkDone()
  })
}

function serve() {
  // app.use(express.static('./build'))

  app.use(express.static(path.join(__dirname, './build')))

  if (process.env.NODE_ENV !== 'production') {
    //the dev server is running on an other port
    app.use(function(req, res, next) {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
      next()
    })
  }

  if (!argv.development) {
    app.get('/', function (req, res) {
      res.sendFile(path.join(__dirname, './build', 'index.html'))
    })
  }

  app.post('/data', function (req, res) {
    res.json({
      data: sourceFile.data,
      path: sourceFile.path,
    })
  })

  app.post('/save', function (req, res) {
    const data = req.body
    if (!data || !data.rasa_nlu_data) {
      res.json({error: 'file is invalid'})
    }
    fs.writeFile(sourceFile.path, JSON.stringify(data, null, 2), (error) => {
      if (error) {
        return res.json({error})
      }
      readData(sourceFile.path)
        .then(json => sourceFile.data = json)
        .catch(error => console.error(error))
        .then(() => res.json({ok: true}))
    })
  })

  app.post('/extract', function(req, res) {
    triggerWebhook('/extract_webhook').then(resp => {
      if (resp.job) {
        readData(sourceFile.path).
          then(json => sourceFile.data = json).
          catch(error => console.error(error)).
          then(() => res.json({ok: true}))
      } else {
        return res.json({resp})
      }
    })
  })

  app.post('/train', function(req, res) {
    triggerWebhook('/train_webhook').then(resp => {
      if (resp.job) {
        res.json({ok: true})
      } else {
        return res.json({resp})
      }
    })
  })

  if (argv.port) {
    listen(argv.port)
  }
  else {
    getPort().then(port => listen(port))
  }

  function listen(port) {
    app.listen(port)
    if (!argv.development) {
      const url = `http://localhost:${port}/`
      console.log(`server listening at ${url}`)
      open(url)
    }
    else {
      console.log('dev server listening at', port)
    }
  }
}
