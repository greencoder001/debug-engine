const open = require('open')
const path = require('path')
const fs = require('fs')
const express = require('express')
const http = require('http')
const socketIO = require('socket.io')
const onFinished = require('on-finished')
const onHeaders = require('on-headers')

class DebugEngine {
    constructor (env = 'development') {
        this.deactivated = false
        if (env === 'production' || env === 'test') {
            // Non-debug mode
            // Do nothing
            this.deactivated = true
        }

        const _warn = console.warn.bind(console)
        const _error = console.error.bind(console)
        const _log = console.log.bind(console)

        this.console = console
        this.targetApps = []
        this.routes = []

        this._warnBuffer = []
        this._errorBuffer = []
        this._logBuffer = []

        this._requestPayloads = []
        
        if (!this.deactivated) {
            this.console.log = (...args) => {
                _log(...args)
                let __isFunc = false
                let __isErr = false
                args = args.map(arg => {
                    if (arg instanceof Error) {
                        __isErr = true
                        return `Error: ${arg.message}`
                    }

                    if (typeof arg === 'function') { __isFunc = true; return arg.toString() }
                    return arg
                })
                this._logBuffer.push({
                    args,
                    __isFunc,
                    __isErr,
                    stack: new Error().stack.toString(),
                    at: new Date()
                })
                this.io.emit('console.log-output', {
                    args,
                    __isFunc,
                    __isErr,
                    stack: new Error().stack.toString(),
                    at: new Date()
                })
            }
            this.console.error = (...args) => {
                _error(...args)
                let __isFunc = false
                let __isErr = false
                args = args.map(arg => {
                    if (arg instanceof Error) {
                        __isErr = true
                        return `Error: ${arg.message}`
                    }

                    if (typeof arg === 'function') { __isFunc = true; return arg.toString() }
                    return arg
                })
                this._errorBuffer.push({
                    args,
                    __isFunc,
                    __isErr,
                    stack: new Error().stack.toString(),
                    at: new Date()
                })
                this.io.emit('console.error-output', {
                    args,
                    __isFunc,
                    __isErr,
                    stack: new Error().stack.toString(),
                    at: new Date()
                })
            }
            this.console.warn = (...args) => {
                _warn(...args)
                let __isFunc = false
                let __isErr = false
                args = args.map(arg => {
                    if (arg instanceof Error) {
                        __isErr = true
                        return `Error: ${arg.message}`
                    }

                    if (typeof arg === 'function') { __isFunc = true; return arg.toString() }
                    return arg
                })
                this._warnBuffer.push({
                    args,
                    __isFunc,
                    __isErr,
                    stack: new Error().stack.toString(),
                    at: new Date()
                })
                this.io.emit('console.warn-output', {
                    args,
                    __isFunc,
                    __isErr,
                    stack: new Error().stack.toString(),
                    at: new Date()
                })
            }

            this.debuggerServer = express()
            this.httpServer = http.createServer(this.debuggerServer)
            this.io = socketIO(this.httpServer)
            this.initServer()
            this.httpServer.listen(5050, () => {
                this.debugServerInitialized()
            })
        }
    }

    initServer () {
        const app = this.debuggerServer
        const io = this.io

        app.use(express.static(path.join(__dirname, 'debug-engine-routes')))

        io.on('connection', (socket) => {
            // Logs
            for (const log of this._logBuffer) {
                socket.emit('console.log-output', log)
            }
            for (const log of this._warnBuffer) {
                socket.emit('console.warn-output', log)
            }
            for (const log of this._errorBuffer) {
                socket.emit('console.error-output', log)
            }

            // Requests
            for (const payload of this._requestPayloads) {
                socket.emit('new-request', payload)
            }

            // Routes
            socket.emit('routes', this.routes)

            // File Tree
            socket.emit('file-tree', this.getFileTree())
        })
    }

    debugServerInitialized () {
        const url = `http://localhost:5050`
        open(url)
    }

    onListening () {
        const self = this

        return function () {
            // Dispatched when the server is listening
            for (const app of self.targetApps) {
                const routesStack = app._router.stack.filter(route => route.route)
                for (const route of routesStack) {
                    const routePath = route.route.path
                    self.routes.push({
                        path: routePath,
                        methods: Object.keys(route.route.methods).join(',').toUpperCase(),
                        handler: route.route.stack[0].handle.toString()
                    })
                }
            }
        }
    }

    getFileTree () {
        const pm = require('parent-modules')
        const parentModule = pm().pop()
        const folder = path.dirname(parentModule)

        function genTree (folder) {
            const files = fs.readdirSync(folder)
            const tree = {}
            for (const file of files) {
                const filePath = path.join(folder, file)
                const stats = fs.statSync(filePath)
                if (stats.isDirectory()) {
                    tree[file] = genTree(filePath)
                } else {
                    tree[file] = filePath
                }
            }
            return tree
        }

        let tree = genTree(folder)

        // For every file in the tree, change the value to the file contents
        // If tree[file] is an object, then it's a folder and we need to recurse

        function getFileContents (_tree) {
            for (const file in _tree) {
                if (typeof _tree[file] === 'object') {
                    _tree[file] = getFileContents(_tree[file])
                } else {
                    _tree[file] = fs.readFileSync(_tree[file], 'utf8').toString('utf8')
                }
            }

            return _tree
        }

        tree = getFileContents(tree)

        return tree
    }

    pipe (app) {
        const self = this

        function mw (req, res, next) {
            const startTimeStamp = new Date()

            onFinished(res, () => {
                const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress
                const endTimeStamp = new Date()

                const payload = {
                    url: req.url,
                    fullUrl: `${req.headers.host}${req.url}`,
                    method: req.method,
                    headers: req.headers,
                    body: req.body,
                    params: req.params,
                    query: req.query,
                    timestamp: endTimeStamp,
                    startTimeStamp: startTimeStamp,
                    session: req.session,
                    ip,
                    response: {
                        statusCode: res.statusCode,
                        headers: res.getHeaders(),
                        responseTimeInMs: endTimeStamp - startTimeStamp
                    }
                }

                self._requestPayloads.push(payload)
                self.io.emit('new-request', payload)
            })

            next()
        }

        this.targetApps.push(app)

        if (!this.deactivated) app.use(mw)
    }
}

module.exports = DebugEngine