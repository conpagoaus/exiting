'use strict';

const Hoek = require('hoek');


const internals = {
    manager: null,
    signals: {
        SIGINT: true,
        SIGQUIT: true,
        SIGTERM: true,
        SIGHUP: false
    },
    processExit: null
};


internals.exit = async function (code) {

    const manager = internals.manager;

    if (!manager) {
        return;          // exit processing was disabled
    }

    if (typeof code === 'number' && code > manager.exitCode) {
        manager.exitCode = code;
    }

    if (!manager.exitTimer) {
        manager.exitTimer = setTimeout(() => {

            manager.state = 'timeout';
            return internals.exit(255);
        }, manager.exitTimeout);
    }

    if (manager.state === 'starting') {
        manager.state = 'startAborted';
        return;
    }

    if (manager.state === 'startAborted') {        // wait until started
        return;
    }

    if (manager.state === 'started') {

        internals.manager.server.ext('onPreStop', (server) => {

            manager.state = 'prestopped';

            if (manager.exitCode !== 0) {
                throw new Error('Process aborted');
            }
        });

        try {
            await internals.stop({ timeout: manager.exitTimeout - 500 });
        }
        catch (err) {
            exports.log('Server stop failed:', err.stack);
        }

        return internals.exit();
    }

    if (manager.state === 'stopping') {        // wait until stopped
        return;
    }

    if (manager.state === 'prestopped' && manager.exitCode === 0) {
        return;
    }

    // Perform actual exit

    internals.processExit(manager.exitCode);
};


internals.abortHandler = function (event) {

    if (this.listenerCount(event) === 1) {
        return internals.exit(1);
    }
};


internals.gracefulHandler = function (event) {

    if (this.listenerCount(event) === 1) {
        return internals.exit(0);
    }
};


internals.uncaughtExceptionHandler = function (err) {

    if (err instanceof exports.ProcessExitError) {     // Ignore ProcessExitError, since we are already handling it
        return;
    }

    exports.log('Fatal Exception:', (err || {}).stack || err);

    if (internals.manager.state === 'stopping' ||
        internals.manager.state === 'prestopped') {    // Exceptions while stopping advance to error state immediately

        internals.manager.state = 'errored';
    }

    return internals.exit(255);
};


internals.listenerClosedHandler = function () {

    // If server is closed without stopping, exit with error

    if (internals.manager && internals.manager.state === 'started') {
        return internals.exit(255);
    }
};


internals.stop = async function (options) {

    const manager = internals.manager;

    try {
        manager.state = 'stopping';
        await manager.server.stop(options);
        manager.state = 'stopped';
    }
    catch (err) {
        manager.state = 'errored';
        throw err;
    }
};


internals.badExitCheck = function () {

    const state = internals.manager.state;
    if (state !== 'stopped' && state !== 'errored' && state !== 'timeout') {
        exports.log('Process exiting without stopping server (state == ' + state + ')');
    }
};


internals.setupExitHooks = function () {

    process.on('uncaughtException', internals.uncaughtExceptionHandler);

    for (const event in internals.signals) {
        let handler = internals.signals[event];
        if (handler === true) {
            handler = internals.signals[event] = internals.gracefulHandler.bind(process, event);
        }
        else if (handler === false) {
            handler = internals.signals[event] = internals.abortHandler.bind(process, event);
        }

        process.prependListener(event, handler);
    }

    process.on('beforeExit', internals.exit);
    process.on('exit', internals.badExitCheck);

    // Monkey patch process.exit()

    internals.processExit = process.exit;
    process.exit = (code) => {

        internals.exit(code);

        // Since we didn't actually exit, throw an error to escape the current scope

        throw new exports.ProcessExitError();
    };
};


internals.teardownExitHooks = function () {

    process.exit = internals.processExit;

    for (const event in internals.signals) {
        process.removeListener(event, internals.signals[event]);
    }

    process.removeListener('beforeExit', internals.exit);
    process.removeListener('exit', internals.badExitCheck);
    process.removeListener('uncaughtException', internals.uncaughtExceptionHandler);

    internals.processExit = null;
};


exports.Manager = class {

    constructor(server, options = {}) {

        Hoek.assert(!internals.manager, 'Only one manager can be created');

        this.exitTimeout = options.exitTimeout || 5000;

        this.server = server;

        this.state = null;       // ['starting', 'started', 'stopping', 'prestopped', 'stopped', 'startAborted', 'errored', 'timeout']
        this.exitTimer = null;
        this.exitCode = 0;

        internals.manager = this;
    }

    async start() {

        if (!this.state) {
            internals.setupExitHooks();
        }

        this.state = 'starting';

        try {
            await this.server.start();
        }
        catch (err) {
            throw err;
        }
        finally {
            const aborted = (this.state === 'startAborted');
            this.state = 'started';

            if (aborted) {                    // Note that throw is not returned when aborted
                return internals.exit();      // eslint-disable-line no-unsafe-finally
            }

            // Attach close listeners to catch spurious closes

            this.server.listener.once('close', internals.listenerClosedHandler);
        }

        return this;
    }

    stop(options = {}) {

        Hoek.assert(this.state === 'started', 'Stop requires that server is started');

        this.state = 'stopping';

        return internals.stop(options);
    }
};


exports.createManager = function (server, options) {

    return new exports.Manager(server, options);
};


exports.log = function (...args) {

    console.error('[exiting]', ...args);
};


exports.reset = function () {

    if (internals.processExit) {
        internals.teardownExitHooks();
    }
    if (internals.manager) {
        clearTimeout(internals.manager.exitTimer);
    }
    internals.manager = null;
};


exports.ProcessExitError = class extends TypeError {

    constructor() {

        super('process.exit() was called');
    }
};
